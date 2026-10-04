package expo.modules.florasecurepush

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal object FscpPreviewNative {
  val loaded: Boolean = try {
    System.loadLibrary("fscp_mobile_ffi")
    true
  } catch (_: UnsatisfiedLinkError) {
    false
  }

  external fun generateKeypair(): String?
  external fun openPreview(
    wire: String,
    recipientUserUuid: String,
    installationUuid: String,
    previewKeyId: String,
    privateKeyBase64Url: String,
  ): String?
}

internal data class SecurePushCapability(
  val installationUuid: String,
  val previewKeyId: String,
  val publicKeyBase64Url: String,
)

internal class SecurePushKeyStore(context: Context) {
  private val appContext = context.applicationContext
  private val prefs = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  fun ensure(ownerUserUuid: String): SecurePushCapability {
    require(FscpPreviewNative.loaded) { "FSCP native preview crypto is unavailable" }
    val owner = ownerUserUuid.trim().lowercase()
    val existing = capability()
    if (prefs.getString(KEY_OWNER, null) == owner && existing != null && readPrivateKey() != null) {
      return existing
    }
    clear()
    val generated = JSONObject(requireNotNull(FscpPreviewNative.generateKeypair()))
    val privateKey = generated.getString("privateKeyBase64Url")
    val encrypted = encrypt(privateKey.toByteArray(Charsets.UTF_8))
    privateFile().writeText("${encrypted.second}\n${encrypted.first}", Charsets.UTF_8)
    val capability = SecurePushCapability(
      installationUuid = UUID.randomUUID().toString(),
      previewKeyId = generated.getString("previewKeyId"),
      publicKeyBase64Url = generated.getString("publicKeyBase64Url"),
    )
    prefs.edit()
      .putString(KEY_OWNER, owner)
      .putString(KEY_INSTALLATION, capability.installationUuid)
      .putString(KEY_ID, capability.previewKeyId)
      .putString(KEY_PUBLIC, capability.publicKeyBase64Url)
      .apply()
    return capability
  }

  fun capability(): SecurePushCapability? {
    val installation = prefs.getString(KEY_INSTALLATION, null) ?: return null
    val keyId = prefs.getString(KEY_ID, null) ?: return null
    val publicKey = prefs.getString(KEY_PUBLIC, null) ?: return null
    return SecurePushCapability(installation, keyId, publicKey)
  }

  fun ownerUserUuid(): String? = prefs.getString(KEY_OWNER, null)

  fun readPrivateKey(): String? {
    val parts = runCatching { privateFile().readLines(Charsets.UTF_8) }.getOrNull()
      ?: return null
    if (parts.size != 2) return null
    val iv = parts[0]
    val encrypted = parts[1]
    return runCatching {
      String(decrypt(encrypted, iv), Charsets.UTF_8)
    }.getOrNull()
  }

  fun previewsEnabled(): Boolean = prefs.getBoolean(KEY_ENABLED, true)

  fun setPreviewsEnabled(enabled: Boolean) {
    prefs.edit().putBoolean(KEY_ENABLED, enabled).apply()
  }

  fun activeConversation(): String? = prefs.getString(KEY_ACTIVE_CONVERSATION, null)
  fun isAppForeground(): Boolean = prefs.getBoolean(KEY_APP_FOREGROUND, false)

  fun setActiveConversation(conversationUuid: String?) {
    prefs.edit().apply {
      if (conversationUuid.isNullOrBlank()) remove(KEY_ACTIVE_CONVERSATION)
      else putString(KEY_ACTIVE_CONVERSATION, conversationUuid.trim().lowercase())
    }.apply()
  }

  fun setAppForeground(foreground: Boolean) {
    prefs.edit().putBoolean(KEY_APP_FOREGROUND, foreground).apply()
  }

  fun clear() {
    val enabled = previewsEnabled()
    privateFile().delete()
    prefs.edit().clear().putBoolean(KEY_ENABLED, enabled).apply()
  }

  private fun privateFile() =
    java.io.File(appContext.noBackupFilesDir, "flora_secure_push_private_v1")

  private fun encrypt(plaintext: ByteArray): Pair<String, String> {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, secretKey())
    return Pair(
      Base64.encodeToString(cipher.doFinal(plaintext), Base64.NO_WRAP),
      Base64.encodeToString(cipher.iv, Base64.NO_WRAP),
    )
  }

  private fun decrypt(ciphertext: String, iv: String): ByteArray {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(
      Cipher.DECRYPT_MODE,
      secretKey(),
      GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)),
    )
    return cipher.doFinal(Base64.decode(ciphertext, Base64.NO_WRAP))
  }

  private fun secretKey(): SecretKey {
    val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
      init(
        KeyGenParameterSpec.Builder(
          KEY_ALIAS,
          KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
          .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
          .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
          .setRandomizedEncryptionRequired(true)
          .build(),
      )
      generateKey()
    }
  }

  private companion object {
    const val PREFS = "flora_secure_push_v1"
    const val KEY_ALIAS = "flora_secure_push_aes_v1"
    const val KEY_OWNER = "owner"
    const val KEY_INSTALLATION = "installation"
    const val KEY_ID = "key_id"
    const val KEY_PUBLIC = "public"
    const val KEY_ENABLED = "enabled"
    const val KEY_ACTIVE_CONVERSATION = "active_conversation"
    const val KEY_APP_FOREGROUND = "app_foreground"
  }
}
