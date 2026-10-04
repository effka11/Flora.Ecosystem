import { memo, useEffect, useReducer } from "react";

import { ChatVoiceWaveform } from "@/components/messages/ChatVoiceWaveform";
import {
  getLiveWaveformDisplay,
  subscribeLiveWaveformDisplay,
} from "@/lib/voiceWaveformLiveBus";

type Props = {
  isFromMe?: boolean;
};

/** Live-волна: подписка на bus, ре-рендер только этого виджета. */
function ChatVoiceLiveWaveformInner({ isFromMe = true }: Props) {
  const [, bump] = useReducer((tick: number) => tick + 1, 0);

  useEffect(() => subscribeLiveWaveformDisplay(() => bump()), []);

  return <ChatVoiceWaveform levels={getLiveWaveformDisplay()} isFromMe={isFromMe} live />;
}

export const ChatVoiceLiveWaveform = memo(ChatVoiceLiveWaveformInner);
