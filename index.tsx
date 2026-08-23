



import "./styles.css";

import { addContextMenuPatch, NavContextMenuPatchCallback, removeContextMenuPatch } from "@api/ContextMenu";
import { showNotification } from "@api/Notifications";
import ErrorBoundary from "@components/ErrorBoundary";
import { fetchUserProfile } from "@utils/discord";
import definePlugin from "@utils/types";
import { findComponentByCodeLazy } from "@webpack";
import { ChannelStore, GuildStore, Menu, PresenceStore, useEffect, UserProfileStore, UserStore,useState, VoiceStateStore } from "@webpack/common";

import { openPresenceHistoryModal, StalkerIcon } from "./components";
import { getWhitelistedIds, settings } from "./settings";
import {
    activityLogCooldowns,
    addPresenceLog,
    captureProfileSnapshot,
    detectProfileChanges,
    getProfileChangeLabel,
    getUserConfig,
    lastKnownActivities,
    lastKnownStatuses,
    lastKnownUsers,
    lastOfflineTimestamps,
    lastOnlineTimestamps,
    loadLastOfflineTimestamps,
    loadPresenceLogs,
    loadProfileSnapshots,
    loadUserConfigs,
    mergeProfileSnapshots,
    offlineDurations,
    onlineDurations,
    pendingOnlineLogs,
    persistLastOfflineTimestamp,
    persistProfileSnapshot,
    presenceLogs,
    pendingActivityLogs,
    recentCurrentUserMessages,
    typingCooldowns,
    activeDeviceTimings,
    lastKnownClientStatuses,
    lastKnownVoiceChannels,
    voiceSessionStarts,
    updateDeviceTimings
} from "./store";
import { ProfileChanges, ProfileSnapshot, UserStalkerConfig, VoiceAction } from "./types";
import {
    addToWhitelist,
    describeVoiceTransition,
    formatActivitySummary,
    getActivitySnapshots,
    getDurationLabel,
    getVoiceActionLabel,
    isInWhitelist,
    logger,
    removeFromWhitelist,
    summarizeClientStatus
} from "./utils";

const _HeaderBarIcon = findComponentByCodeLazy(".HEADER_BAR_BADGE_TOP:", '.iconBadge,"top"');

const HeaderBarIcon = _HeaderBarIcon ?? ((props: any) => {
    const Icon = props.icon;
    return (
        <div
            className={props.className}
            onClick={props.onClick}
            title={props.tooltip}
            style={{ display: "inline-flex", alignItems: "center", cursor: "pointer", height: 24 }}
        >
            {Icon ? <Icon /> : null}
        </div>
    );
});

function OpenStalkerButton() {
    return (
        <HeaderBarIcon
            className="stalker-toolbox-btn"
            onClick={() => openPresenceHistoryModal()}
            tooltip={"Activity Tracker"}
            icon={StalkerIcon}
        />
    );
}

function getClientStatusSnapshot(userId: string) {
    const stateStatuses = (PresenceStore as any)?.getState?.()?.clientStatuses?.[userId];
    const direct = (PresenceStore as any)?.getClientStatuses?.(userId);
    return { ...(stateStatuses ?? {}), ...(direct ?? {}) };
}


function shouldTrackGuild(config: UserStalkerConfig, guildId?: string | null) {
    if (!guildId) return false;
    if (config.serverFilterMode === "whitelist") return config.serverList.includes(guildId);
    if (config.serverFilterMode === "blacklist") return !config.serverList.includes(guildId);
    return true;
}

function resolveVoiceChannel(channelId?: string | null) {
    if (!channelId) return null;
    const channel = ChannelStore.getChannel(channelId);
    const guildId = channel?.guild_id ?? null;
    // DM / group calls have no guild - this plugin only tracks servers you share with the user.
    if (!guildId) return null;
    return {
        channelId,
        channelName: channel?.name ?? null,
        guildId,
        guildName: GuildStore.getGuild(guildId)?.name ?? null
    };
}

function primeVoiceChannel(userId: string) {
    try {
        const state = (VoiceStateStore as any)?.getVoiceStateForUser?.(userId);
        lastKnownVoiceChannels.set(userId, state?.channelId ?? null);
    } catch (e) {
        logger.error(`Failed to prime voice state for ${userId}`, e);
    }
}

function handleVoiceStateUpdate(userId: string, state: any) {
    const newChannelId: string | null = state?.channelId ?? state?.channel_id ?? null;
    // Prefer our own bookkeeping over the payload's oldChannelId: Discord re-dispatches voice
    // states on mute/deafen toggles and when guilds are (re)loaded, and only a real channel
    // change should produce an event.
    const previousChannelId: string | null = lastKnownVoiceChannels.has(userId)
        ? lastKnownVoiceChannels.get(userId)!
        : (state?.oldChannelId ?? state?.old_channel_id ?? null);

    if (previousChannelId === newChannelId) return;
    lastKnownVoiceChannels.set(userId, newChannelId);

    const from = resolveVoiceChannel(previousChannelId);
    const to = resolveVoiceChannel(newChannelId);
    if (!from && !to) return;

    const now = Date.now();
    const sessionStart = voiceSessionStarts.get(userId);
    // Only guild voice sessions are timed, so a session that started in a DM call is not reported.
    const voiceDuration = from && sessionStart ? now - sessionStart : undefined;
    if (to) voiceSessionStarts.set(userId, now);
    else voiceSessionStarts.delete(userId);

    const action: VoiceAction = !from ? "join" : !to ? "leave" : "move";

    const config = getUserConfig(userId);
    // A move between two servers counts if either side is tracked.
    if (!shouldTrackGuild(config, to?.guildId) && !shouldTrackGuild(config, from?.guildId)) return;
    if (!config.logVoiceStates && !config.notifyVoiceStates) return;

    const user = UserStore.getUser(userId);
    const username = user?.username ?? lastKnownUsers.get(userId)?.username ?? "unknown";
    const primary = to ?? from!;

    const entry = {
        userId,
        username,
        discriminator: user?.discriminator,
        timestamp: now,
        previousStatus: undefined,
        currentStatus: PresenceStore.getStatus(userId) ?? null,
        guildId: primary.guildId,
        clientStatus: {},
        activitySummary: `voice:${action}`,
        clientStatusSummary: undefined,
        guildName: primary.guildName,
        type: "voice" as const,
        channelId: primary.channelId,
        channelName: primary.channelName ?? undefined,
        voiceAction: action,
        voiceChannelId: to?.channelId ?? null,
        voiceChannelName: to?.channelName ?? null,
        voiceOldChannelId: from?.channelId ?? null,
        voiceOldChannelName: from?.channelName ?? null,
        voiceOldGuildId: from?.guildId ?? null,
        voiceOldGuildName: from?.guildName ?? null,
        voiceDuration
    };

    if (config.logVoiceStates) addPresenceLog(entry);

    const notifyForAction = action === "join"
        ? config.notifyVoiceJoin !== false
        : action === "leave"
            ? config.notifyVoiceLeave !== false
            : config.notifyVoiceMove !== false;

    if (config.notifyVoiceStates && notifyForAction) {
        try {
            let body = describeVoiceTransition(entry);
            const durationLabel = getDurationLabel(voiceDuration);
            if (durationLabel) body += ` (after ${durationLabel})`;

            const snapshot = lastKnownUsers.get(userId);
            const avatar = snapshot?.avatar ?? user?.avatar ?? null;

            showNotification({
                title: `${username} ${getVoiceActionLabel(action).toLowerCase()}`,
                body,
                icon: avatar ? `https://cdn.discordapp.com/avatars/${userId}/${avatar}.png?size=64` : undefined
            });
        } catch (e) {  }
    }
}

async function stalkUser(id: string) {
    addToWhitelist(id);
    primeVoiceChannel(id);
    try {
        const u = UserStore.getUser(id);
        if (u) {
            logger.info(`Tracking user ${u.username}, fetching profile...`);
            const userProfile = await fetchUserProfile(id);
            await new Promise(resolve => setTimeout(resolve, 800));

            if (userProfile && !lastKnownUsers.has(id)) {
                const avatar = u.avatar ?? null;
                const banner = userProfile.banner ?? u.banner ?? null;
                const avatarDecorationData = (userProfile as any).avatarDecorationData ?? (u as any).avatarDecorationData ?? (u as any).avatar_decoration_data ?? null;
                const currentActivities = PresenceStore.getActivities(id) || [];
                const customStatusActivity = currentActivities.find(a => a?.type === 4);
                const customStatus = customStatusActivity?.state ?? null;

                const currentSnapshot: ProfileSnapshot = {
                    username: u.username,
                    avatar,
                    discriminator: u.discriminator,
                    global_name: (u as any).global_name ?? (u as any).globalName ?? null,
                    bio: userProfile.bio ?? null,
                    banner,
                    banner_color: (userProfile as any).bannerColor ?? (u as any).banner_color ?? (u as any).bannerColor ?? null,
                    avatarDecoration: avatarDecorationData?.asset ?? null,
                    avatarDecorationData,
                    customStatus
                };
                await persistProfileSnapshot(id, currentSnapshot);
                logger.info(`Profile fetched for ${u.username}, baseline established`);
            }
        }
    } catch (e) {
        logger.error("Failed to fetch profile for stalked user", e);
    }
}

function unStalkUser(id: string) {
    removeFromWhitelist(id);
    lastKnownUsers.delete(id);
    lastKnownVoiceChannels.delete(id);
    voiceSessionStarts.delete(id);
}

const Section = findComponentByCodeLazy("headingVariant:", ".section", ".header");

export default definePlugin({
    name: "Activity Tracker",
    description: "Advanced user presence and activity monitoring plugin that logs presence changes, profile updates, messages, voice channel activity, and status updates. Track when users change their status, join or leave voice channels, monitor profile edits, view historical activity trends, and receive customizable notifications for selected users.",
    authors: [{ id: 534759293065625620n, name: "Ondra_D" }],
    settings,
    patches: [
        {
            find: ".connections,userId:",
            replacement: {
                match: /#{intl::USER_PROFILE_MEMBER_SINCE}\),.{0,100}userId:(\i\.id),.{0,100}}\)}\),/,
                replace: "$&,$self.StalkerOverviewComponent({userId:$1})"
            }
        },
        {
            find: ".MODAL_V2,onClose:",
            replacement: {
                match: /#{intl::USER_PROFILE_MEMBER_SINCE}\),.{0,100}userId:(\i\.id),.{0,100}}\)}\),/,
                replace: "$&,$self.StalkerOverviewComponent({userId:$1})"
            }
        },
        {
            find: 'section:"MUTUAL_FRIENDS"',
            replacement: {
                match: /\i\|\|\i(?=\?\(0,\i\.jsxs?\)\(\i\.\i\.Overlay,)/,
                replace: "$&||$self.shouldShowStalkerOverview(arguments[0].user.id)"
            }
        },
        {
            find: 'section:"MUTUAL_FRIENDS"',
            replacement: {
                match: /\.openUserProfileModal.+?\)}\)}\)(?<=,(\i)&&(\i)&&\(0,\i\.jsxs?\)\((\i(?:\.\i)?),{className:(\i)\.divider}\).+?)/,
                replace: (m, hasMutualGuilds, hasMutualFriends, DividerComponent) => "" +
                    `${m},$self.StalkerOverviewComponent({userId:arguments[0].user.id, hasDivider:${hasMutualGuilds}||${hasMutualFriends}, Divider:${DividerComponent}})`
            }
        }
    ],
    shouldShowStalkerOverview: (userId: string) => {
        return getWhitelistedIds().includes(userId);
    },
    StalkerOverviewComponent: ErrorBoundary.wrap(({ userId, Divider }: { userId: string; Divider?: any; }) => {
        const [_, forceUpdate] = useState(0);

        useEffect(() => {
            const interval = setInterval(() => forceUpdate(n => n + 1), 1000);
            return () => clearInterval(interval);
        }, []);

        const whitelisted = getWhitelistedIds();
        if (!whitelisted.includes(userId)) return null;

        const isOnline = (status: string | null) => status && !["offline", "invisible"].includes(status?.toLowerCase() ?? "");
        const currentStatus = PresenceStore.getStatus(userId);
        const online = isOnline(currentStatus);
        const userLogs = presenceLogs.filter(log => log.userId === userId);
        const now = Date.now();
        let text: string;
        let lastSeenText = "Unknown";

        if (online) {
            const lastOnlineLog = userLogs.find(log =>
                isOnline(log.currentStatus) && !isOnline(log.previousStatus ?? null)
            );

            if (lastOnlineLog) {
                const duration = now - lastOnlineLog.timestamp;
                text = `Online for ${getDurationLabel(duration)}`;
            } else {
                text = "Online";
            }
        } else {
            const lastOfflineLog = userLogs.find(log =>
                !isOnline(log.currentStatus) && isOnline(log.previousStatus ?? null)
            );

            if (lastOfflineLog) {
                const duration = now - lastOfflineLog.timestamp;
                text = `Offline for ${getDurationLabel(duration)}`;
                lastSeenText = new Date(lastOfflineLog.timestamp).toLocaleString();
            } else {
                text = "Offline";
            }
        }

        const totalLogs = userLogs.length;

        if (Divider !== undefined) {
            return (
                <div className="stalker-overview-card">
                    <div className="stalker-overview-card-header">STALKER OVERVIEW</div>
                    <div className="stalker-overview-card-body">
                        <div className="stalker-overview-stat">
                            <span className="stalker-overview-stat-label">Status:</span>
                            <span className="stalker-overview-stat-value">{text}</span>
                        </div>
                        {!online && (
                            <div className="stalker-overview-stat">
                                <span className="stalker-overview-stat-label">Last Seen:</span>
                                <span className="stalker-overview-stat-value">{lastSeenText}</span>
                            </div>
                        )}
                        <div className="stalker-overview-stat">
                            <span className="stalker-overview-stat-label">Total Logs:</span>
                            <span className="stalker-overview-stat-value">{totalLogs}</span>
                        </div>
                    </div>
                </div>
            );
        }

        return (
            <Section title="Stalker Overview">
                <div className="stalker-overview-text">{text}</div>
            </Section>
        );
    }),
    flux: {
        async USER_PROFILE_FETCH_SUCCESS(payload: any) {
            try {
                const userProfile = payload?.userProfile;
                if (!userProfile) return;

                const { user } = userProfile;
                if (!user || !user.id) return;

                const { id } = user;
                const whitelisted = getWhitelistedIds();
                if (!whitelisted.includes(id)) return;

                const cur = UserStore.getUser(id);
                if (!cur) return;

                const prev = lastKnownUsers.get(id);
                const profileData = userProfile.user_profile || {};

                const connectedAccounts = (userProfile.connected_accounts || []).map((acc: any) => ({
                    type: acc.type,
                    name: acc.name,
                    verified: acc.verified
                }));

                const currentAvatar = cur.avatar ?? null;
                const currentBanner = profileData.banner ?? user.banner ?? cur.banner ?? null;
                const avatarDecorationData = profileData.avatar_decoration_data ?? (cur as any).avatarDecorationData ?? (cur as any).avatar_decoration_data ?? null;
                const status = PresenceStore.getStatus(id);
                const isOnline = status && status !== "offline" && status !== "invisible";
                const currentActivities = PresenceStore.getActivities(id) || [];
                const customStatusActivity = currentActivities.find(a => a?.type === 4);
                const customStatus = isOnline ? (customStatusActivity?.state ?? null) : (prev?.customStatus ?? null);

                const newSnapshot: ProfileSnapshot = {
                    username: cur.username,
                    avatar: currentAvatar,
                    discriminator: cur.discriminator,
                    global_name: (cur as any).global_name ?? (cur as any).globalName ?? null,
                    bio: profileData.bio ?? null,
                    banner: currentBanner,
                    banner_color: profileData.banner_color ?? (cur as any).banner_color ?? (cur as any).bannerColor ?? null,
                    avatarDecoration: avatarDecorationData?.asset ?? null,
                    avatarDecorationData,
                    connected_accounts: connectedAccounts,
                    pronouns: profileData.pronouns ?? null,
                    theme_colors: profileData.theme_colors ?? null,
                    emoji: profileData.emoji ?? null,
                    customStatus
                };
                const mergedSnapshot = mergeProfileSnapshots(prev, newSnapshot);

                if (!prev) {
                    await persistProfileSnapshot(id, mergedSnapshot);
                    return;
                }
                const changes = detectProfileChanges(prev, mergedSnapshot);

                if (changes.length > 0) {
                    logger.info(`Profile changes detected for ${cur.username}:`, changes);
                    await persistProfileSnapshot(id, mergedSnapshot);

                    const userConfig = getUserConfig(id);
                    if (userConfig.logProfileChanges) {
                        const profileChanges: ProfileChanges = {
                            changedFields: changes,
                            before: prev,
                            after: mergedSnapshot
                        };

                        addPresenceLog({
                            userId: id,
                            username: cur.username,
                            discriminator: cur.discriminator,
                            timestamp: Date.now(),
                            previousStatus: undefined,
                            currentStatus: PresenceStore.getStatus(id) ?? null,
                            guildId: undefined,
                            clientStatus: {},
                            activitySummary: `profile:${changes.join(",")}`,
                            clientStatusSummary: undefined,
                            guildName: null,
                            type: "profile",
                            profileChanges
                        } as any);

                        if (userConfig.notifyProfileChanges) {
                            const filteredChanges = changes.filter(change => {
                                if (change === "username" && userConfig.notifyUsername !== false) return true;
                                if (change === "avatar" && userConfig.notifyAvatar !== false) return true;
                                if (change === "banner" && userConfig.notifyBanner !== false) return true;
                                if (change === "bio" && userConfig.notifyBio !== false) return true;
                                if (change === "pronouns" && userConfig.notifyPronouns !== false) return true;
                                if (change === "display_name" && userConfig.notifyGlobalName !== false) return true;
                                if (!["username", "avatar", "banner", "bio", "pronouns", "display_name"].includes(change)) return true;
                                return false;
                            });

                            if (filteredChanges.length > 0) {
                                try {
                                    const changeLabels = filteredChanges.map(c => getProfileChangeLabel(c));
                                    showNotification({
                                        title: `${cur.username} updated profile`,
                                        body: changeLabels.join(", "),
                                        icon: cur.avatar ? `https://cdn.discordapp.com/avatars/${id}/${cur.avatar}.png?size=64` : undefined
                                    });
                                } catch (e) {  }
                            }
                        }
                    }
                } else {
                    await persistProfileSnapshot(id, mergedSnapshot);
                }
            } catch (e) {
                logger.error("Error in USER_PROFILE_FETCH_SUCCESS handler", e);
            }
        },
        async USER_UPDATE(payload: any) {
            try {
                const user = payload?.user;
                if (!user || !user.id) return;

                const { id } = user;
                const whitelisted = getWhitelistedIds();
                if (!whitelisted.includes(id)) return;

                const prev = lastKnownUsers.get(id);
                if (!prev) return;

                const cur = UserStore.getUser(id);
                if (!cur) return;
                const status = PresenceStore.getStatus(id);
                const isOnline = status && status !== "offline" && status !== "invisible";
                const currentActivities = PresenceStore.getActivities(id) || [];
                const capturedSnapshot = captureProfileSnapshot(cur, UserProfileStore, currentActivities);
                if (capturedSnapshot.bio === undefined) {
                    fetchUserProfile(id);
                }
                if (!isOnline && prev.customStatus !== undefined) {
                    capturedSnapshot.customStatus = prev.customStatus;
                }
                const mergedSnapshot = mergeProfileSnapshots(prev, capturedSnapshot);
                const changes = detectProfileChanges(prev, mergedSnapshot);

                if (changes.length > 0) {
                    logger.info(`USER_UPDATE changes for ${cur.username}:`, changes);
                    await persistProfileSnapshot(id, mergedSnapshot);

                    const userConfig = getUserConfig(id);
                    if (userConfig.logProfileChanges) {
                        const profileChanges: ProfileChanges = {
                            changedFields: changes,
                            before: prev,
                            after: mergedSnapshot
                        };

                        addPresenceLog({
                            userId: id,
                            username: cur.username,
                            discriminator: cur.discriminator,
                            timestamp: Date.now(),
                            previousStatus: undefined,
                            currentStatus: PresenceStore.getStatus(id) ?? null,
                            guildId: undefined,
                            clientStatus: {},
                            activitySummary: `profile:${changes.join(",")}`,
                            clientStatusSummary: undefined,
                            guildName: null,
                            type: "profile",
                            profileChanges
                        } as any);

                        if (userConfig.notifyProfileChanges) {
                            const filteredChanges = changes.filter(change => {
                                if (change === "username" && userConfig.notifyUsername !== false) return true;
                                if (change === "avatar" && userConfig.notifyAvatar !== false) return true;
                                if (change === "banner" && userConfig.notifyBanner !== false) return true;
                                if (change === "bio" && userConfig.notifyBio !== false) return true;
                                if (change === "pronouns" && userConfig.notifyPronouns !== false) return true;
                                if (change === "display_name" && userConfig.notifyGlobalName !== false) return true;
                                if (!["username", "avatar", "banner", "bio", "pronouns", "display_name"].includes(change)) return true;
                                return false;
                            });

                            if (filteredChanges.length > 0) {
                                try {
                                    const changeLabels = filteredChanges.map(c => getProfileChangeLabel(c));
                                    showNotification({
                                        title: `${cur.username} updated profile`,
                                        body: changeLabels.join(", "),
                                        icon: cur.avatar ? `https://cdn.discordapp.com/avatars/${id}/${cur.avatar}.png?size=64` : undefined
                                    });
                                } catch (e) {  }
                            }
                        }
                    }
                }
            } catch (e) {
                logger.error("Error in USER_UPDATE handler", e);
            }
        },
        TYPING_START(evt: any) {
            try {
                const userId = evt?.user?.id ?? evt?.userId ?? evt?.actor?.id;
                if (!userId) return;
                const channelId = evt?.channelId ?? evt?.channel?.id ?? null;

                const user = UserStore.getUser(userId);
                if (!user) return;

                const whitelisted = getWhitelistedIds();
                if (!whitelisted.includes(userId)) return;

                const now = Date.now();
                const cooldownExpiry = typingCooldowns.get(userId);
                if (cooldownExpiry && now < cooldownExpiry) return;

                const userConfig = getUserConfig(userId);
                const conversationWindowMinutes = userConfig.typingConversationWindow ?? 10;
                const conversationWindow = conversationWindowMinutes * 60_000;

                const lastCurrentUserMessage = recentCurrentUserMessages.get(channelId);
                if (lastCurrentUserMessage && (now - lastCurrentUserMessage) < conversationWindow) return;

                const lastStalkedUserMessage = recentCurrentUserMessages.get(`${channelId}-${userId}`);
                if (lastStalkedUserMessage && (now - lastStalkedUserMessage) < conversationWindow) return;

                if (userConfig.notifyTyping) {
                    try {
                        const channel = channelId ? ChannelStore.getChannel(channelId) : null;
                        const guildId = channel?.guild_id;
                        const guild = guildId ? GuildStore.getGuild(guildId) : null;

                        let contextText = "in DMs";
                        if (guild) {
                            contextText = `in ${guild.name}`;
                        } else if (channel && channel.type === 3) {
                            contextText = `in ${channel.name || "Group DM"}`;
                        }

                        const snapshot = lastKnownUsers.get(userId);
                        const avatarUrl = snapshot ? (snapshot.avatar ? `https://cdn.discordapp.com/avatars/${userId}/${snapshot.avatar}.png?size=64` : null) : null;

                        showNotification({
                            title: `${user.username} is typing`,
                            body: contextText,
                            icon: avatarUrl ?? undefined
                        });

                        typingCooldowns.set(userId, now + 20_000);
                    } catch (e) {  }
                }
            } catch (e) {
                logger.error("Typing listener error", e);
            }
        },
        MESSAGE_CREATE(msg: any) {
            try {
                const payload = msg?.message ?? msg;
                const author = payload?.author ?? msg?.author ?? msg?.message?.author ?? msg?.user;
                const authorId = author?.id ?? msg?.authorId;

                if (!authorId) return;

                const channelId = payload?.channel_id ?? payload?.channelId ?? msg?.channel_id ?? msg?.channelId ?? msg?.channel?.id ?? null;
                const messageId = payload?.id ?? msg?.id ?? null;
                const channel = channelId ? ChannelStore.getChannel(channelId) : null;
                const channelName = channel?.name;

                if (authorId === UserStore.getCurrentUser().id && channelId) {
                    recentCurrentUserMessages.set(channelId, Date.now());
                }

                const whitelisted = getWhitelistedIds();
                if (!whitelisted.includes(authorId)) return;

                if (channelId) {
                    recentCurrentUserMessages.set(`${channelId}-${authorId}`, Date.now());
                }

                const guildId = payload?.guild_id ?? payload?.guildId ?? msg?.guild_id ?? msg?.guildId ?? msg?.guild?.id ?? null;
                if (!guildId || guildId === "@me") return;

                const userConfig = getUserConfig(authorId);

                if (!shouldTrackGuild(userConfig, guildId)) return;
                if (!userConfig.logMessages) return;

                let content = payload?.content ?? msg.content ?? "";
                const limit = 100;
                if (limit > 0 && content.length > limit) content = content.slice(0, limit) + "...";

                const user = UserStore.getUser(authorId) ?? author;
                const guildName = guildId ? GuildStore?.getGuild?.(guildId)?.name : undefined;

                if (userConfig.logMessages) {
                    addPresenceLog({
                        userId: authorId,
                        username: user?.username ?? author?.username ?? "unknown",
                        discriminator: user?.discriminator ?? author?.discriminator,
                        timestamp: Date.now(),
                        previousStatus: undefined,
                        currentStatus: PresenceStore.getStatus(authorId) ?? null,
                        guildId,
                        clientStatus: {},
                        activitySummary: "message",
                        clientStatusSummary: undefined,
                        guildName: guildName ?? null,
                        type: "message",
                        channelId,
                        messageContent: content,
                        messageId,
                        channelName
                    } as any);
                }

                typingCooldowns.set(authorId, Date.now() + 20_000);

                if (userConfig.notifyMessages) {
                    try {
                        const channel = channelId ? ChannelStore.getChannel(channelId) : null;
                        const guild = guildId ? GuildStore.getGuild(guildId) : null;

                        let contextText = "in DMs";
                        if (guild) {
                            contextText = `in ${guild.name}`;
                        } else if (channel && channel.type === 3) {
                            contextText = `in ${channel.name || "Group DM"}`;
                        }

                        const snapshot = lastKnownUsers.get(authorId);
                        const avatarUrl = snapshot ? (snapshot.avatar ? `https://cdn.discordapp.com/avatars/${authorId}/${snapshot.avatar}.png?size=64` : null) : null;

                        showNotification({
                            title: `${user?.username ?? author?.username ?? "User"} sent a message ${contextText}`,
                            body: content || "(message hidden)",
                            icon: avatarUrl ?? (user?.avatar ? `https://cdn.discordapp.com/avatars/${authorId}/${user.avatar}.png?size=64` : undefined)
                        });
                    } catch (e) {  }
                }
            } catch (e) {
                logger.error("Message listener error", e);
            }
        },
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: any[]; }) {
            try {
                if (!Array.isArray(voiceStates) || !voiceStates.length) return;

                const whitelisted = getWhitelistedIds();
                if (!whitelisted.length) return;

                for (const state of voiceStates) {
                    const userId = state?.userId ?? state?.user_id;
                    if (!userId || !whitelisted.includes(userId)) continue;
                    handleVoiceStateUpdate(userId, state);
                }
            } catch (e) {
                logger.error("Voice state listener error", e);
            }
        }
    },
    addIconToToolBar(e: { toolbar: any; }) {
        if (Array.isArray(e.toolbar))
            return e.toolbar.unshift(
                <ErrorBoundary noop={true}>
                    <OpenStalkerButton />
                </ErrorBoundary>
            );

        e.toolbar = [
            <ErrorBoundary noop={true} key="stalker-button">
                <OpenStalkerButton />
            </ErrorBoundary>,
            e.toolbar,
        ];
    },
    TrailingWrapper({ children }: any) {
        try {

            return (
                <>
                    {children}
                    <ErrorBoundary noop>
                        <OpenStalkerButton />
                    </ErrorBoundary>
                </>
            );
        } catch (e) {
            logger.error("Failed to render trailing wrapper for Stalker button", e);
            return children;
        }
    },
    presenceListener: null as any,
    presencePrimed: false,
    async start() {
        this.presencePrimed = false;


        await Promise.all([
            loadLastOfflineTimestamps(),
            loadProfileSnapshots(),
            loadUserConfigs()
        ]);

        // Baseline where tracked users already are, so a mute toggle or a guild (re)load right
        // after start does not look like a fresh voice join.
        for (const userId of getWhitelistedIds()) primeVoiceChannel(userId);

        this.presenceListener = async () => {
            try {
                const whitelistedIds = getWhitelistedIds();
                if (!this.presencePrimed) {
                    for (const userId of whitelistedIds) {
                        const currentStatus = PresenceStore.getStatus(userId) ?? null;
                        const currentActivities = PresenceStore.getActivities(userId) || [];
                        lastKnownStatuses.set(userId, currentStatus);
                        lastKnownActivities.set(userId, currentActivities);
                        lastKnownClientStatuses.set(userId, getClientStatusSnapshot(userId));

                        const isOnline = (status: string | null) => status && !["offline", "invisible"].includes(status?.toLowerCase() ?? "");
                        if (isOnline(currentStatus)) {
                            lastOnlineTimestamps.set(userId, Date.now());
                        } else {
                            if (!lastOfflineTimestamps.has(userId)) {
                                persistLastOfflineTimestamp(userId, Date.now());
                            }
                        }
                    }
                    this.presencePrimed = true;
                    return;
                }

                for (const userId of whitelistedIds) {
                    const currentStatus = PresenceStore.getStatus(userId);
                    const previousStatus = lastKnownStatuses.get(userId) ?? null;

                    const currentActivities = PresenceStore.getActivities(userId) || [];
                    const previousActivities = lastKnownActivities.get(userId) || [];
                    const currentCustomStatus = currentActivities.find(a => a?.type === 4);
                    const previousCustomStatus = previousActivities.find(a => a?.type === 4);
                    const customStatusChanged = currentCustomStatus?.state !== previousCustomStatus?.state;

                    const filteredCurrentActivities = currentActivities.filter(a => a?.type !== 4);
                    const filteredPreviousActivities = previousActivities.filter(a => a?.type !== 4);

                    const activitySnapshot = getActivitySnapshots(filteredCurrentActivities);
                    const previousActivitySnapshot = getActivitySnapshots(filteredPreviousActivities);
                    const activitySummary = formatActivitySummary(filteredCurrentActivities);

                    const statusChanged = previousStatus !== currentStatus && currentStatus !== undefined;
                    const activitiesChanged = JSON.stringify(previousActivitySnapshot) !== JSON.stringify(activitySnapshot);
                    const currentClientStatus = getClientStatusSnapshot(userId);
                    const previousClientStatus = lastKnownClientStatuses.get(userId) ?? {};
                    const clientStatusChanged = JSON.stringify(currentClientStatus) !== JSON.stringify(previousClientStatus);
                    if (customStatusChanged) {
                        const user = UserStore.getUser(userId);
                        const isOnline = (status: string | null) => status && !["offline", "invisible"].includes(status?.toLowerCase() ?? "");

                        if (user && isOnline(currentStatus)) {
                            const currentSnapshot = captureProfileSnapshot(user, UserProfileStore, currentActivities);
                            const prev = lastKnownUsers.get(userId);

                            if (prev) {
                                const mergedSnapshot = mergeProfileSnapshots(prev, currentSnapshot);
                                const changes = detectProfileChanges(prev, mergedSnapshot);

                                if (changes.length > 0) {
                                    lastKnownUsers.set(userId, mergedSnapshot);
                                    await persistProfileSnapshot(userId, mergedSnapshot);

                                    const userConfig = getUserConfig(userId);
                                    if (userConfig.logProfileChanges) {
                                        const profileChanges: ProfileChanges = {
                                            changedFields: changes,
                                            before: prev,
                                            after: mergedSnapshot
                                        };

                                        addPresenceLog({
                                            userId,
                                            username: user.username,
                                            discriminator: user.discriminator,
                                            timestamp: Date.now(),
                                            previousStatus: undefined,
                                            currentStatus: PresenceStore.getStatus(userId) ?? null,
                                            guildId: undefined,
                                            clientStatus: {},
                                            activitySummary: `profile:${changes.join(",")}`,
                                            clientStatusSummary: undefined,
                                            guildName: null,
                                            type: "profile",
                                            profileChanges
                                        } as any);

                                        if (userConfig.notifyProfileChanges) {
                                            try {
                                                const changeLabels = changes.map(c => getProfileChangeLabel(c));
                                                showNotification({
                                                    title: `${user.username} updated profile`,
                                                    body: changeLabels.join(", "),
                                                    icon: user.avatar ? `https://cdn.discordapp.com/avatars/${userId}/${user.avatar}.png?size=64` : undefined
                                                });
                                            } catch (e) {  }
                                        }
                                    }
                                }
                            }
                        }
                    }

                    if (statusChanged || activitiesChanged || clientStatusChanged) {
                        lastKnownStatuses.set(userId, currentStatus);
                        lastKnownActivities.set(userId, currentActivities);
                        lastKnownClientStatuses.set(userId, currentClientStatus);
                        const clientStatusMap = currentClientStatus;
                        const clientStatusSummary = summarizeClientStatus(clientStatusMap);

                        const user = UserStore.getUser(userId);
                        if (!user) continue;

                        let offlineDuration: number | undefined;
                        let onlineDuration: number | undefined;
                        const now = Date.now();

                        const { result: deviceTimings, changed: deviceChange } = updateDeviceTimings(userId, currentStatus, clientStatusMap, now);

                        const isOnline = (status: string | null) => status && !["offline", "invisible"].includes(status?.toLowerCase() ?? "");

                        if (statusChanged) {
                            if (isOnline(currentStatus)) {
                                if (!isOnline(previousStatus)) {
                                    const lastOffline = lastOfflineTimestamps.get(userId);
                                    if (lastOffline) offlineDuration = now - lastOffline;
                                }
                                lastOnlineTimestamps.set(userId, now);
                            } else if (!isOnline(currentStatus)) {
                                const lastOnline = lastOnlineTimestamps.get(userId);
                                if (lastOnline) onlineDuration = now - lastOnline;
                                persistLastOfflineTimestamp(userId, now);
                            }
                        }

                        if (isOnline(currentStatus)) {
                            const lastOnline = lastOnlineTimestamps.get(userId);
                            if (lastOnline) onlineDuration = now - lastOnline;
                        } else {
                            const lastOffline = lastOfflineTimestamps.get(userId);
                            if (lastOffline) offlineDuration = now - lastOffline;
                        }

                        if (statusChanged) {
                            offlineDuration ? offlineDurations.set(userId, offlineDuration) : offlineDurations.delete(userId);
                            onlineDuration ? onlineDurations.set(userId, onlineDuration) : onlineDurations.delete(userId);
                        }

                        const userConfig = getUserConfig(userId);
                        if (userConfig.logPresenceChanges) {
                            const isOnlineTransition = statusChanged && isOnline(currentStatus) && !isOnline(previousStatus);

                            const entry = {
                                userId,
                                username: user.username,
                                discriminator: user.discriminator,
                                timestamp: now,
                                previousStatus: statusChanged ? previousStatus : undefined,
                                currentStatus,
                                guildId: undefined,
                                clientStatus: clientStatusMap,
                                activitySummary,
                                clientStatusSummary,
                                guildName: null,
                                offlineDuration,
                                onlineDuration,
                                activities: activitySnapshot,
                                type: "presence" as const,
                                deviceTimings,
                                deviceChange,
                                activityChange: activitiesChanged
                            };

                            if (isOnlineTransition) {
                                const pending = pendingOnlineLogs.get(userId);
                                if (pending) clearTimeout(pending.timeout);

                                addPresenceLog(entry);
                                pendingOnlineLogs.delete(userId);
                            } else {
                                if (!pendingOnlineLogs.has(userId)) {
                                    if (clientStatusChanged && !statusChanged && !activitiesChanged) {
                                        addPresenceLog(entry);
                                    } else if (statusChanged) {
                                        const pending = pendingActivityLogs.get(userId);
                                        if (pending) {
                                            clearTimeout(pending.timeout);
                                            pendingActivityLogs.delete(userId);
                                        }
                                        addPresenceLog(entry);
                                    } else if (activitiesChanged) {
                                        const pending = pendingActivityLogs.get(userId);
                                        if (pending) clearTimeout(pending.timeout);

                                        const timeout = setTimeout(() => {
                                            addPresenceLog(pendingActivityLogs.get(userId)?.entry ?? entry);
                                            pendingActivityLogs.delete(userId);
                                            activityLogCooldowns.set(userId, Date.now());
                                        }, 1000);

                                        pendingActivityLogs.set(userId, { timeout, entry });
                                    }
                                }
                            }
                        }
                    }
                }
            } catch (e) {
                logger.error("Error in presence listener", e);
            }
        };

        PresenceStore.addChangeListener(this.presenceListener);
        addContextMenuPatch("user-context", contextMenuPatch);

        await loadPresenceLogs();
    },
    async stop() {
        if (this.presenceListener) {
            PresenceStore.removeChangeListener(this.presenceListener);
            this.presenceListener = null;
        }
        removeContextMenuPatch("user-context", contextMenuPatch);

        pendingOnlineLogs.forEach(p => clearTimeout(p.timeout));
        pendingOnlineLogs.clear();
        pendingActivityLogs.forEach(p => clearTimeout(p.timeout));
        pendingActivityLogs.clear();

        // Re-primed on the next start(); keeping them would produce bogus durations after a long stop.
        lastKnownVoiceChannels.clear();
        voiceSessionStarts.clear();
    }
});

const contextMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    if (!props || props?.user?.id === UserStore.getCurrentUser().id) return;

    if (!children.some(child => child?.props?.id === "stalker-v1")) {
        const userId = props.user.id;
        const isWhitelisted = isInWhitelist(userId);
        const menuItems = [
            <Menu.MenuSeparator key="stalker-sep" />,
            <Menu.MenuItem
                key="stalker-item"
                id="stalker-v1"
                label={isWhitelisted ? "Stop Tracking User" : "Track User"}
                action={() => isWhitelisted ? unStalkUser(userId) : stalkUser(userId)}
            />
        ];

        if (isWhitelisted) {
            menuItems.push(
                <Menu.MenuItem
                    id="stalker-view-log"
                    label="View Presence History"
                    action={() => openPresenceHistoryModal(userId)}
                />
            );
        }

        children.push(...menuItems);
    }
};

export { settings };

