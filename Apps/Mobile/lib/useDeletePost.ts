import { apiDeletePost } from "@flora/client-core/api";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { Alert } from "react-native";
import { removePostFromSocialCaches } from "@/lib/removePostFromSocialCaches";

/** Подтверждение + DELETE; после успеха пост снимается с ленты, профиля и стены сообщества. */
export function useDeletePost() {
  const queryClient = useQueryClient();
  return useCallback(
    (postUuid: string) => {
      Alert.alert("Удалить пост?", "Это действие нельзя отменить.", [
        { text: "Отмена", style: "cancel" },
        {
          text: "Удалить",
          style: "destructive",
          onPress: () => {
            void (async () => {
              try {
                await apiDeletePost(postUuid);
                removePostFromSocialCaches(queryClient, postUuid);
              } catch (err) {
                Alert.alert(
                  "Удаление",
                  err instanceof Error ? err.message : "Не удалось удалить пост.",
                );
              }
            })();
          },
        },
      ]);
    },
    [queryClient],
  );
}
