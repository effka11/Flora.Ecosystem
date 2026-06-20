type ActiveVoicePlayer = {
  id: string;
  pause: () => void;
};

let activePlayer: ActiveVoicePlayer | null = null;

export function requestVoicePlayback(playerId: string, pause: () => void): void {
  if (activePlayer && activePlayer.id !== playerId) {
    activePlayer.pause();
  }
  activePlayer = { id: playerId, pause };
}

export function releaseVoicePlayback(playerId: string): void {
  if (activePlayer?.id === playerId) {
    activePlayer = null;
  }
}

export function stopActiveVoicePlayback(): void {
  if (activePlayer) {
    activePlayer.pause();
    activePlayer = null;
  }
}
