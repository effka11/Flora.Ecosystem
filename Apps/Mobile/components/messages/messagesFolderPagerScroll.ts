import type { ChatListFolderId } from "@flora/client-core/messaging";
import type { SharedValue } from "react-native-reanimated";

/** Общий scroll pager’а папок — иконки читают его как подвкладки ленты. */
export type MessagesFolderPagerScroll = {
  scrollX: SharedValue<number>;
  pageWidthSV: SharedValue<number>;
  pages: readonly ChatListFolderId[];
  /**
   * Тап all↔иконка N: chrome fade на N (не едет через промежуточные).
   * returnFromPageSV — якорь; returnProgressSV 0 = all, 1 = выделена на якоре.
   * 0 / неактивно — chrome снова от scrollX (свайп).
   */
  returnFromPageSV: SharedValue<number>;
  returnProgressSV: SharedValue<number>;
};
