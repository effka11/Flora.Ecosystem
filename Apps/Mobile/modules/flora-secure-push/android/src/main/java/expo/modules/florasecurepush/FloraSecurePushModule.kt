package expo.modules.florasecurepush

import android.app.NotificationManager
import android.content.Context
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class FloraSecurePushModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("FloraSecurePush")

    Function("ensureCapability") { ownerUserUuid: String ->
      val capability = store().ensure(ownerUserUuid)
      mapOf(
        "installationUuid" to capability.installationUuid,
        "securePreviewVersion" to 1,
        "previewKeyId" to capability.previewKeyId,
        "previewPublicKeyBase64Url" to capability.publicKeyBase64Url,
      )
    }

    Function("setPreviewsEnabled") { enabled: Boolean ->
      store().setPreviewsEnabled(enabled)
    }

    Function("arePreviewsEnabled") {
      store().previewsEnabled()
    }

    Function("setActiveConversation") { conversationUuid: String? ->
      store().setActiveConversation(conversationUuid)
    }

    Function("setAppForeground") { foreground: Boolean ->
      store().setAppForeground(foreground)
    }

    Function("cancelConversationNotification") { conversationUuid: String ->
      val manager = context().getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      val normalized = conversationUuid.trim().lowercase()
      manager.cancel(normalized, normalized.hashCode())
    }

    Function("clear") {
      store().clear()
    }
  }

  private fun context(): Context =
    requireNotNull(appContext.reactContext).applicationContext

  private fun store() = SecurePushKeyStore(context())
}
