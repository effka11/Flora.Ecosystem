import UserNotifications
import Security

final class NotificationService: UNNotificationServiceExtension {
  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var bestAttemptContent: UNMutableNotificationContent?

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    self.contentHandler = contentHandler
    guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
      contentHandler(request.content)
      return
    }
    bestAttemptContent = content
    defer {
      contentHandler(content)
      self.contentHandler = nil
      self.bestAttemptContent = nil
    }

    let store = ExtensionSecurePushStore()
    let context = store.context()
    guard store.previewsEnabled(),
          let envelope = content.userInfo["encryptedPreview"] as? String,
          let owner = context?["owner"],
          let installation = context?["installationUuid"],
          let keyId = context?["previewKeyId"],
          let privateKey = store.privateKey() else {
      return
    }
    var output = [CChar](repeating: 0, count: 1024)
    let result = envelope.withCString { wire in
      owner.withCString { recipient in
        installation.withCString { installationUuid in
          keyId.withCString { previewKeyId in
            privateKey.withCString { privateKeyValue in
              fscp_mobile_open_notification_preview(
                wire,
                recipient,
                installationUuid,
                previewKeyId,
                privateKeyValue,
                &output,
                output.count
              )
            }
          }
        }
      }
    }
    if result == 0 {
      let preview = String(cString: output).trimmingCharacters(in: .whitespacesAndNewlines)
      if !preview.isEmpty { content.body = preview }
    }
  }

  override func serviceExtensionTimeWillExpire() {
    if let contentHandler, let bestAttemptContent {
      contentHandler(bestAttemptContent)
    }
  }
}

private final class ExtensionSecurePushStore {
  private let defaults: UserDefaults
  private let accessGroup: String?

  init() {
    let appGroup = Bundle.main.object(forInfoDictionaryKey: "FloraSecurePushAppGroup") as? String
    defaults = appGroup.flatMap(UserDefaults.init(suiteName:)) ?? .standard
    accessGroup = Bundle.main.object(forInfoDictionaryKey: "FloraSecurePushKeychainGroup") as? String
  }

  func previewsEnabled() -> Bool {
    defaults.object(forKey: "enabled") == nil ? true : defaults.bool(forKey: "enabled")
  }
  func context() -> [String: String]? {
    var query = keychainQuery(account: "preview-context")
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: AnyObject?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
          let data = result as? Data else { return nil }
    return try? JSONSerialization.jsonObject(with: data) as? [String: String]
  }

  func privateKey() -> String? {
    var query = keychainQuery(account: "preview-private-key")
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: AnyObject?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
          let data = result as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  private func keychainQuery(account: String) -> [String: Any] {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "social.flora.secure-push.v1",
      kSecAttrAccount as String: account
    ]
    if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
    return query
  }
}
