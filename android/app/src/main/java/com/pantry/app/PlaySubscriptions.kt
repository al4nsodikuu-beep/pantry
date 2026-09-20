package com.pantry.app

import android.app.Activity
import com.android.billingclient.api.*
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Google Play handles payment. Only the backend can acknowledge or grant access. */
class PlaySubscriptions(
    private val activity: Activity,
    private val api: BillingApi,
    private val scope: CoroutineScope,
    private val entitlementChanged: (JSONObject) -> Unit,
    private val verificationFailed: () -> Unit
) : PurchasesUpdatedListener {
    private val client = BillingClient.newBuilder(activity)
        .setListener(this)
        .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
        .enableAutoServiceReconnection()
        .build()
    private val connectionLock = Mutex()
    private var checkout: CompletableDeferred<JSONObject>? = null
    private var expectedProduct: String? = null

    private fun failure(result: BillingResult): SubscriptionException = SubscriptionException(when(result.responseCode) {
        BillingClient.BillingResponseCode.USER_CANCELED -> "purchase_canceled"
        BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED -> "already_subscribed"
        BillingClient.BillingResponseCode.ITEM_UNAVAILABLE -> "product_unavailable"
        BillingClient.BillingResponseCode.BILLING_UNAVAILABLE,
        BillingClient.BillingResponseCode.SERVICE_UNAVAILABLE,
        BillingClient.BillingResponseCode.SERVICE_DISCONNECTED -> "billing_unavailable"
        else -> "purchase_failed"
    })
    private suspend fun connect() = connectionLock.withLock {
        if (!client.isReady) withTimeout(20000) {
            suspendCancellableCoroutine<Unit> { continuation ->
                client.startConnection(object : BillingClientStateListener {
                    override fun onBillingSetupFinished(result: BillingResult) {
                        if (!continuation.isActive) return
                        if (result.responseCode == BillingClient.BillingResponseCode.OK) continuation.resume(Unit)
                        else continuation.resumeWithException(failure(result))
                    }
                    override fun onBillingServiceDisconnected() { /* Auto reconnection on the next request. */ }
                })
            }
        }
    }
    private suspend fun context(): JSONObject {
        val data = api.call("/api/billing/context")
        if (data.getString("package_name") != activity.packageName) throw SubscriptionException("billing_not_configured")
        expectedProduct = data.getString("product_id")
        return data
    }
    private suspend fun product(context: JSONObject): ProductDetails {
        connect()
        val params = QueryProductDetailsParams.newBuilder().setProductList(listOf(
            QueryProductDetailsParams.Product.newBuilder().setProductId(context.getString("product_id"))
                .setProductType(BillingClient.ProductType.SUBS).build()
        )).build()
        return withTimeout(20000) { suspendCancellableCoroutine { continuation ->
            client.queryProductDetailsAsync(params) { result, response ->
                if (continuation.isActive) {
                    val detail = response.productDetailsList.firstOrNull { it.productId == context.getString("product_id") }
                    if (result.responseCode != BillingClient.BillingResponseCode.OK) continuation.resumeWithException(failure(result))
                    else if (detail == null) continuation.resumeWithException(SubscriptionException("product_unavailable"))
                    else continuation.resume(detail)
                }
            }
        } }
    }
    private fun offers(details: ProductDetails, context: JSONObject): List<ProductDetails.SubscriptionOfferDetails> {
        val allowed = context.getJSONArray("base_plans")
        return details.subscriptionOfferDetails.orEmpty().filter { offer ->
            (0 until allowed.length()).any { allowed.getString(it) == offer.basePlanId } && offer.offerId == null &&
                offer.pricingPhases.pricingPhaseList.any { it.recurrenceMode == ProductDetails.RecurrenceMode.INFINITE_RECURRING }
        }
    }
    suspend fun catalog(): JSONObject {
        val context = context()
        val entitlement = restore(context)
        val products = JSONArray()
        if (context.optBoolean("billing_enabled")) {
            val details = product(context)
            for (offer in offers(details, context)) {
                val recurring = offer.pricingPhases.pricingPhaseList.last { it.recurrenceMode == ProductDetails.RecurrenceMode.INFINITE_RECURRING }
                val plan = when(recurring.billingPeriod) { "P1M" -> "monthly"; "P1Y" -> "annual"; else -> continue }
                products.put(JSONObject().put("id", plan).put("base_plan_id", offer.basePlanId)
                    .put("formattedPrice", recurring.formattedPrice).put("currency", recurring.priceCurrencyCode)
                    .put("billing_period", recurring.billingPeriod))
            }
        }
        return JSONObject().put("signed_in", true).put("context", context).put("products", products).put("entitlement", entitlement)
    }
    private suspend fun purchases(): List<Purchase> {
        connect()
        return withTimeout(20000) { suspendCancellableCoroutine { continuation ->
            client.queryPurchasesAsync(QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.SUBS).build()) { result, list ->
                if (continuation.isActive) {
                    if (result.responseCode == BillingClient.BillingResponseCode.OK) continuation.resume(list)
                    else continuation.resumeWithException(failure(result))
                }
            }
        } }
    }
    suspend fun restore(config: JSONObject? = null): JSONObject {
        val context = config ?: context()
        val owned = purchases().filter { it.products.contains(context.getString("product_id")) }
        var ownershipError: SubscriptionException? = null
        for (purchase in owned) {
            if (purchase.purchaseState == Purchase.PurchaseState.PURCHASED) {
                try { api.call("/api/billing/google-play/verify", JSONObject().put("purchase_token", purchase.purchaseToken)) }
                catch (e: SubscriptionException) {
                    if (e.code in setOf("purchase_account_mismatch", "purchase_belongs_to_another_account")) ownershipError = e else throw e
                }
            }
        }
        val entitlement = api.call("/api/entitlements/premium")
        if (!entitlement.optBoolean("active")) {
            ownershipError?.let { throw it }
            if (owned.any { it.purchaseState == Purchase.PurchaseState.PENDING }) {
                entitlement.put("subscription_status", "pending") // Display only. active remains server-provided false.
            }
        }
        entitlementChanged(entitlement)
        return entitlement
    }
    suspend fun purchase(plan: String): JSONObject {
        if (checkout != null) throw SubscriptionException("purchase_failed")
        val config = context()
        if (!config.optBoolean("billing_enabled")) throw SubscriptionException("billing_disabled")
        if (api.call("/api/entitlements/premium").optBoolean("active")) throw SubscriptionException("already_subscribed")
        // Query immediately before launch: never use hardcoded prices or a stale ProductDetails object.
        val details = product(config)
        val period = when(plan) { "monthly" -> "P1M"; "annual" -> "P1Y"; else -> throw SubscriptionException("product_unavailable") }
        val offer = offers(details, config).firstOrNull { it.pricingPhases.pricingPhaseList.any { phase -> phase.billingPeriod == period && phase.recurrenceMode == ProductDetails.RecurrenceMode.INFINITE_RECURRING } }
            ?: throw SubscriptionException("product_unavailable")
        val pending = CompletableDeferred<JSONObject>()
        checkout = pending
        try {
            val params = BillingFlowParams.newBuilder().setObfuscatedAccountId(config.getString("obfuscated_account_id"))
                .setProductDetailsParamsList(listOf(BillingFlowParams.ProductDetailsParams.newBuilder()
                    .setProductDetails(details).setOfferToken(offer.offerToken).build())).build()
            val launched = client.launchBillingFlow(activity, params)
            if (launched.responseCode != BillingClient.BillingResponseCode.OK) throw failure(launched)
            return withTimeout(115000) { pending.await() }
        } finally { checkout = null }
    }
    override fun onPurchasesUpdated(result: BillingResult, list: MutableList<Purchase>?) {
        if (result.responseCode != BillingClient.BillingResponseCode.OK) {
            checkout?.completeExceptionally(failure(result))
            return
        }
        scope.launch {
            try {
                val relevant = list.orEmpty().filter { it.products.contains(expectedProduct) }
                if (relevant.any { it.purchaseState == Purchase.PurchaseState.PENDING }) throw SubscriptionException("pending_purchase")
                if (relevant.isEmpty()) throw SubscriptionException("purchase_failed")
                for (purchase in relevant) {
                    if (purchase.purchaseState != Purchase.PurchaseState.PURCHASED) throw SubscriptionException("pending_purchase")
                    api.call("/api/billing/google-play/verify", JSONObject().put("purchase_token", purchase.purchaseToken))
                }
                val verified = api.call("/api/entitlements/premium")
                entitlementChanged(verified)
                checkout?.complete(verified)
            } catch (e: Exception) { verificationFailed(); checkout?.completeExceptionally(e) }
        }
    }
    fun close() { checkout?.cancel(); client.endConnection() }
}
