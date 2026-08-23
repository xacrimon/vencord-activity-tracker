


export type PresenceStatus = "online" | "idle" | "dnd" | "offline" | "invisible" | string;

export interface ProfileSnapshot {
    username?: string;
    avatar?: string | null;
    discriminator?: string;
    global_name?: string | null;
    bio?: string | null;
    banner?: string | null;
    banner_color?: string | null;
    avatarDecoration?: string | null;
    avatarDecorationData?: { asset: string; skuId: string; } | null;
    connected_accounts?: Array<{ type: string; name: string; verified: boolean; }>;
    pronouns?: string | null;
    theme_colors?: [number, number] | null;
    emoji?: any | null;
    customStatus?: string | null;
}

export interface ProfileChanges {
    changedFields: string[];
    before: ProfileSnapshot;
    after: ProfileSnapshot;
}

export type VoiceAction = "join" | "leave" | "move";

export interface PresenceLogEntry {
    userId: string;
    username: string;
    discriminator?: string;
    timestamp: number;
    previousStatus?: PresenceStatus | null;
    currentStatus: PresenceStatus | null;
    guildId?: string;
    clientStatus?: Record<string, string>;
    activitySummary?: string;
    clientStatusSummary?: string;
    guildName?: string | null;
    type?: "presence" | "profile" | "message" | "typing" | "voice";
    profileChanges?: ProfileChanges;
    offlineDuration?: number;
    onlineDuration?: number;
    activities?: any[];
    channelId?: string;
    channelName?: string;
    messageContent?: string;
    messageId?: string;
    voiceAction?: VoiceAction;
    voiceChannelId?: string | null;
    voiceChannelName?: string | null;
    voiceOldChannelId?: string | null;
    voiceOldChannelName?: string | null;
    voiceOldGuildId?: string | null;
    voiceOldGuildName?: string | null;
    voiceDuration?: number;
    deviceTimings?: Array<{ device: string; status: string; start: number; end?: number | null }>;
    deviceChange?: boolean;
    activityChange?: boolean;
}


export interface UserStalkerConfig {
    userId: string;
    logPresenceChanges: boolean;
    logProfileChanges: boolean;
    logMessages: boolean;
    logVoiceStates: boolean;
    notifyPresenceChanges: boolean;
    notifyProfileChanges: boolean;
    notifyMessages: boolean;
    notifyVoiceStates: boolean;
    notifyTyping: boolean;
    typingConversationWindow?: number;
    serverFilterMode: "all" | "whitelist" | "blacklist";
    serverList: string[];
    notifyOnline?: boolean;
    notifyOffline?: boolean;
    notifyIdle?: boolean;
    notifyDnd?: boolean;
    notifyUsername?: boolean;
    notifyAvatar?: boolean;
    notifyBanner?: boolean;
    notifyBio?: boolean;
    notifyPronouns?: boolean;
    notifyGlobalName?: boolean;
    notifyVoiceJoin?: boolean;
    notifyVoiceLeave?: boolean;
    notifyVoiceMove?: boolean;
}

