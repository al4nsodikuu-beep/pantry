package com.pantry.app

import com.google.firebase.auth.FirebaseAuth
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.URL
import javax.net.ssl.HttpsURLConnection

class SubscriptionException(val code: String) : Exception(code)

/** Account IDs come exclusively from verified Firebase JWTs on the server. */
class BillingApi(private val auth: FirebaseAuth?) {
    suspend fun call(path: String, body: JSONObject? = null): JSONObject {
        val base = BuildConfig.BILLING_API_URL.trimEnd('/')
        if (!base.startsWith("https://") || URL(base).host.isBlank()) throw SubscriptionException("billing_not_configured")
        val user = auth?.currentUser ?: throw SubscriptionException("sign_in_required")
        user.reload().await()
        if (!user.isEmailVerified) throw SubscriptionException("verify_your_email")
        val token = user.getIdToken(true).await().token ?: throw SubscriptionException("invalid_account_session")
        return withContext(Dispatchers.IO) {
            val connection = URL(base + path).openConnection() as HttpsURLConnection
            try {
                connection.instanceFollowRedirects = false
                connection.connectTimeout = 15000
                connection.readTimeout = 30000
                connection.requestMethod = if (body == null) "GET" else "POST"
                connection.setRequestProperty("Authorization", "Bearer $token")
                connection.setRequestProperty("Accept", "application/json")
                if (body != null) {
                    connection.doOutput = true
                    connection.setRequestProperty("Content-Type", "application/json")
                    connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
                }
                val status = connection.responseCode
                val stream = if (status in 200..299) connection.inputStream else connection.errorStream
                val data = stream?.bufferedReader()?.use { it.readText() } ?: "{}"
                val result = try { JSONObject(data) } catch (_: Exception) { throw SubscriptionException("service_unavailable") }
                if (status !in 200..299) throw SubscriptionException(result.optString("error", "service_unavailable"))
                result
            } catch (e: SubscriptionException) { throw e }
            catch (_: Exception) { throw SubscriptionException("service_unavailable") }
            finally { connection.disconnect() }
        }
    }
}
