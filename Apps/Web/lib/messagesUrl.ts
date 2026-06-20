/** Deep-link в приложение сообщений: открыть тред с пользователем (после входа query очищается). */
export function messagesOpenChatQuery(profile: { userUuid: string; username: string; displayName: string }): string {
  const q = new URLSearchParams();
  q.set("with", profile.userUuid);
  q.set("u", profile.username.replace(/^@+/, ""));
  q.set("n", profile.displayName);
  return `/messages?${q.toString()}`;
}
