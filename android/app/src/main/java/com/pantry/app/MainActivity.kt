package com.pantry.app

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.text.InputType
import android.webkit.*
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import kotlinx.coroutines.*
import kotlinx.coroutines.tasks.await
import org.json.JSONObject
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class MainActivity : Activity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private lateinit var web: WebView
    private var auth: FirebaseAuth? = null
    private lateinit var api: BillingApi
    private lateinit var play: PlaySubscriptions
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var ready = false
    private var refreshJob: Job? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (listOf(BuildConfig.FIREBASE_PROJECT_ID, BuildConfig.FIREBASE_APP_ID, BuildConfig.FIREBASE_API_KEY).all { it.isNotBlank() }) {
            val app = FirebaseApp.getApps(this).firstOrNull() ?: FirebaseApp.initializeApp(this, FirebaseOptions.Builder()
                .setProjectId(BuildConfig.FIREBASE_PROJECT_ID).setApplicationId(BuildConfig.FIREBASE_APP_ID)
                .setApiKey(BuildConfig.FIREBASE_API_KEY).build())
            auth = FirebaseAuth.getInstance(app)
        }
        api = BillingApi(auth)
        play = PlaySubscriptions(this, api, scope, { event("pantry-entitlement", it) }, { event("pantry-verification-error", JSONObject()) })
        web = WebView(this)
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            setContentView(TextView(this).apply { text = "Update Android System WebView to use Pantry securely." })
            return
        }
        val assets = WebViewAssetLoader.Builder().addPathHandler("/", WebViewAssetLoader.AssetsPathHandler(this)).build()
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                if (request.url.scheme == "https" && request.url.host == "appassets.androidplatform.net") return assets.shouldInterceptRequest(request.url)
                return WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", emptyMap(), "Blocked".byteInputStream())
            }
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true
            override fun onPageFinished(view: WebView, url: String) { ready = true; refresh() }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null); fileCallback = callback
                @Suppress("DEPRECATION")
                startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("image/*"), 42)
                return true
            }
        }
        WebViewCompat.addWebMessageListener(web, "PantryNative", setOf("https://appassets.androidplatform.net")) { _, message, origin, isMainFrame, reply ->
            if (!isMainFrame || origin.toString() != "https://appassets.androidplatform.net") return@addWebMessageListener
            val input = try { JSONObject(message.data ?: "{}") } catch (_: Exception) { return@addWebMessageListener }
            val id = input.optString("id")
            if (id.length !in 1..64) return@addWebMessageListener
            scope.launch {
                val response = JSONObject().put("id", id)
                try { response.put("result", handle(input.getString("action"), input.optJSONObject("payload") ?: JSONObject())) }
                catch (e: SubscriptionException) { response.put("error", e.code) }
                catch (_: TimeoutCancellationException) { response.put("error", "request_timeout") }
                catch (_: Exception) { response.put("error", "service_unavailable") }
                // Never return tokens, private keys or authentication credentials to web content.
                reply.postMessage(response.toString())
            }
        }
        web.setOnApplyWindowInsetsListener { view, insets ->
            @Suppress("DEPRECATION")
            view.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
            insets
        }
        setContentView(web)
        web.loadUrl("https://appassets.androidplatform.net/index.html")
    }
    private suspend fun handle(action: String, payload: JSONObject): JSONObject = when(action) {
        "signin" -> { signIn(); JSONObject().put("signed_in", true) }
        "signout" -> { auth?.signOut(); event("pantry-entitlement", JSONObject().put("active", false)); JSONObject() }
        "catalog" -> if (auth?.currentUser == null) JSONObject().put("signed_in", false).put("products", org.json.JSONArray()) else play.catalog()
        "purchase" -> play.purchase(payload.getString("plan"))
        "restore" -> play.restore()
        "feature" -> {
            val name = payload.getString("name")
            if (name !in setOf("meal-plan", "chef", "scans", "recipes", "substitutions", "nutrition")) throw SubscriptionException("unknown_feature")
            api.call("/api/premium/$name", payload.optJSONObject("body") ?: JSONObject())
        }
        "manage" -> {
            val uri = if (auth?.currentUser != null) {
                try {
                    val config = api.call("/api/billing/context")
                    Uri.parse("https://play.google.com/store/account/subscriptions").buildUpon()
                        .appendQueryParameter("sku", config.getString("product_id"))
                        .appendQueryParameter("package", config.getString("package_name")).build()
                } catch (_: Exception) { Uri.parse("https://play.google.com/store/account/subscriptions") }
            } else Uri.parse("https://play.google.com/store/account/subscriptions")
            startActivity(Intent(Intent.ACTION_VIEW, uri)); JSONObject()
        }
        else -> throw SubscriptionException("unknown_action")
    }
    private suspend fun signIn() {
        val firebase = auth ?: throw SubscriptionException("account_service_not_configured")
        val choice = suspendCancellableCoroutine<Triple<String, String, Boolean>> { continuation ->
            val layout = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(48,24,48,24) }
            val email = EditText(this).apply { hint = "Email"; inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS }
            val password = EditText(this).apply { hint = "Password"; inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD }
            layout.addView(email); layout.addView(password)
            val dialog = AlertDialog.Builder(this).setTitle("Your Pantry account").setView(layout)
                .setPositiveButton("Sign in") { _, _ -> if (continuation.isActive) continuation.resume(Triple(email.text.toString().trim(), password.text.toString(), false)) }
                .setNeutralButton("Create account") { _, _ -> if (continuation.isActive) continuation.resume(Triple(email.text.toString().trim(), password.text.toString(), true)) }
                .setNegativeButton("Cancel") { _, _ -> if (continuation.isActive) continuation.resumeWithException(SubscriptionException("sign_in_required")) }
                .setOnCancelListener { if (continuation.isActive) continuation.resumeWithException(SubscriptionException("sign_in_required")) }.create()
            continuation.invokeOnCancellation { dialog.dismiss() }
            dialog.show()
        }
        try {
            val result = if (choice.third) firebase.createUserWithEmailAndPassword(choice.first, choice.second).await()
                else firebase.signInWithEmailAndPassword(choice.first, choice.second).await()
            val user = result.user ?: throw SubscriptionException("invalid_account_session")
            if (!user.isEmailVerified) {
                user.sendEmailVerification().await()
                throw SubscriptionException("verify_your_email")
            }
        } catch (e: SubscriptionException) { throw e }
        catch (_: Exception) { throw SubscriptionException("invalid_account_session") }
    }
    private fun event(name: String, detail: JSONObject) {
        if (!ready) return
        web.evaluateJavascript("window.dispatchEvent(new CustomEvent(${JSONObject.quote(name)},{detail:JSON.parse(${JSONObject.quote(detail.toString())})}));", null)
    }
    private fun refresh() {
        if (auth?.currentUser != null && ready) scope.launch {
            try { play.restore() } catch (_: Exception) { event("pantry-verification-error", JSONObject()) }
        }
    }
    override fun onResume() {
        super.onResume()
        if (::play.isInitialized) refresh()
        refreshJob?.cancel()
        refreshJob = scope.launch {
            while (isActive) {
                delay(60000)
                if (auth?.currentUser != null && ready) {
                    try { event("pantry-entitlement", api.call("/api/entitlements/premium")) }
                    catch (_: Exception) { event("pantry-verification-error", JSONObject()) }
                }
            }
        }
    }
    override fun onPause() { refreshJob?.cancel(); super.onPause() }
    @Deprecated("Legacy file chooser callback")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode,resultCode,data)
        if (requestCode == 42) { fileCallback?.onReceiveValue(if (resultCode == RESULT_OK && data?.data != null) arrayOf(data.data!!) else null); fileCallback = null }
    }
    override fun onDestroy() { scope.cancel(); if (::play.isInitialized) play.close(); if (::web.isInitialized) web.destroy(); super.onDestroy() }
}
