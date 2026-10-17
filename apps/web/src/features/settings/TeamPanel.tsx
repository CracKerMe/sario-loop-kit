import { Button } from "@loopkit/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@loopkit/ui/components/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@loopkit/ui/components/empty";
import { Input } from "@loopkit/ui/components/input";
import { Label } from "@loopkit/ui/components/label";
import { CopyIcon, MailPlusIcon, UsersIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Dialog } from "@/components/dialog";
import { StatusBadge } from "@/components/status-badge";
import { api, type WorkspaceInviteDto, type WorkspaceMemberDto } from "@/lib/api";

import { CopyField } from "./CopyField";

const ROLES = ["owner", "admin", "member"] as const;
type Role = (typeof ROLES)[number];

export function TeamPanel() {
  const [members, setMembers] = useState<WorkspaceMemberDto[]>([]);
  const [invites, setInvites] = useState<WorkspaceInviteDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [busy, setBusy] = useState(false);
  const [issuedInvite, setIssuedInvite] = useState<{
    invite: WorkspaceInviteDto;
    token: string;
  } | null>(null);

  const load = async () => {
    try {
      const res = await api.members();
      setMembers(res.members);
      setInvites(res.invites);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load team");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const sendInvite = async () => {
    if (!email.trim()) return;
    setBusy(true);
    try {
      const res = await api.inviteMember({ email: email.trim().toLowerCase(), role });
      toast.success("Invite created");
      setInviting(false);
      setEmail("");
      setRole("member");
      setIssuedInvite(res);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Invite failed");
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (member: WorkspaceMemberDto, next: Role) => {
    if (member.role === next) return;
    try {
      await api.updateMemberRole(member.id, next);
      toast.success(`Role updated to ${next}`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Role update failed");
    }
  };

  const inviteUrl = (token: string) =>
    `${typeof window !== "undefined" ? window.location.origin : ""}/invite/${token}`;

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <UsersIcon className="size-4 text-muted-foreground" aria-hidden="true" />
              Team
            </CardTitle>
            <CardDescription>
              Workspace roles control billing, integrations, and send operations.
            </CardDescription>
          </div>
          <Button size="sm" onClick={() => setInviting(true)}>
            <MailPlusIcon className="size-3.5" aria-hidden="true" />
            Invite
          </Button>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="text-xs text-muted-foreground">Loading team…</div>
          ) : error ? (
            <div className="text-xs text-rose-600">{error}</div>
          ) : members.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No members yet</EmptyTitle>
                <EmptyDescription>Invite a teammate to collaborate.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="grid gap-2">
              {members.map((member) => (
                <div
                  key={member.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      {member.name || member.email || member.userId}
                    </div>
                    <div className="text-xs text-muted-foreground">{member.email || "—"}</div>
                  </div>
                  <select
                    className="rounded-lg border border-border bg-background px-2 py-1.5 text-xs"
                    value={member.role}
                    onChange={(e) => void changeRole(member, e.target.value as Role)}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {invites.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Pending invites</CardTitle>
            <CardDescription>Invitations that have not been accepted yet.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-2">
              {invites.map((invite) => (
                <div
                  key={invite.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border px-3 py-2.5"
                >
                  <div>
                    <div className="text-sm">{invite.email}</div>
                    <div className="text-xs text-muted-foreground">
                      {invite.role} · expires {new Date(invite.expiresAt).toLocaleString()}
                    </div>
                  </div>
                  <StatusBadge status={invite.acceptedAt ? "completed" : "pending"} />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Dialog
        open={inviting}
        onClose={() => setInviting(false)}
        title="Invite teammate"
        description="They'll receive an invite link you can share manually in this demo."
      >
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="invite-email">Email</Label>
            <Input
              id="invite-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="teammate@company.com"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="invite-role">Role</Label>
            <select
              id="invite-role"
              className="rounded-lg border border-border bg-background px-2.5 py-2 text-sm"
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <Button onClick={() => void sendInvite()} disabled={busy || !email.trim()}>
            {busy ? "Creating…" : "Create invite"}
          </Button>
        </div>
      </Dialog>

      <Dialog
        open={!!issuedInvite}
        onClose={() => setIssuedInvite(null)}
        title="Share invite link"
        description="Send this URL to your teammate. It can be used once."
      >
        {issuedInvite && (
          <div className="grid gap-3">
            <CopyField label="Invite URL" value={inviteUrl(issuedInvite.token)} />
            <Button
              variant="outline"
              onClick={() => {
                void navigator.clipboard.writeText(inviteUrl(issuedInvite.token));
                toast.success("Copied invite URL");
              }}
            >
              <CopyIcon className="size-3.5" aria-hidden="true" />
              Copy link
            </Button>
          </div>
        )}
      </Dialog>
    </div>
  );
}
