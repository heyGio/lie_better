export type ChatRole = "npc" | "player";
export type NpcMood = "calm" | "suspicious" | "hostile";

export interface HistoryItem {
  role: ChatRole;
  content: string;
}
