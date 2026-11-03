


import { classNameFactory } from "@api/Styles";
import { Paragraph } from "@components/Paragraph";
import { Text } from "@components/Text";
import { ModalCloseButton, ModalContent, ModalHeader, ModalProps, ModalRoot, ModalSize, openModal } from "@utils/modal";
import { ScrollerThin } from "@webpack/common";

import { lastKnownUsers } from "../store";
import { ProfileCard } from "./ProfileCard";

const cl = classNameFactory("stalker-modal-");

export function SnapshotsModal({ modalProps, userId }: { modalProps: ModalProps; userId?: string; }) {
    const allSnapshots = Array.from(lastKnownUsers.entries());
    const snapshots = userId
        ? allSnapshots.filter(([id]) => id === userId)
        : allSnapshots;

    const title = userId ? "Current Profile Snapshot" : "Tracked Profile Snapshots";

    return (
        <ModalRoot {...modalProps} size={ModalSize.LARGE} className={cl("root") + " stalker-modal-root"}>
            <ModalHeader className={cl("head")}>
                <Text size="lg" weight="semibold">{title}</Text>
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>
            <ModalContent className={cl("contents") + " stalker-modal-contents"}>
                <div style={{ padding: "16px 0" }}>
                    {!userId && (
                        <Paragraph style={{ marginBottom: "16px" }}>
                            Currently stalking {snapshots.length} user profiles. These are the latest snapshots used for change detection.
                        </Paragraph>
                    )}

                    {snapshots.length > 0 ? (
                        <ScrollerThin className="stalker-snapshot-list" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "16px" }}>
                            {snapshots.map(([uId, snapshot]) => (
                                <div key={uId} style={{ border: "1px solid var(--background-modifier-accent)", borderRadius: "8px", overflow: "hidden" }}>
                                    <ProfileCard
                                        snapshot={snapshot}
                                        userId={uId}
                                        label={snapshot.username || uId}
                                    />
                                </div>
                            ))}
                        </ScrollerThin>
                    ) : (
                        <Paragraph>No profile snapshots found.</Paragraph>
                    )}
                </div>
            </ModalContent>
        </ModalRoot>
    );
}

export function openSnapshotsModal(userId?: string) {
    openModal(modalProps => (
        <SnapshotsModal modalProps={modalProps} userId={userId} />
    ));
}
