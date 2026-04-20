import { InviteAcceptPanel } from "@/components/invite-accept-panel";

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function InviteAcceptPage({ searchParams }: Props) {
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token : "";
  const invitationId = typeof params.invitationId === "string" ? params.invitationId : "";
  const resolved = token || invitationId;

  if (!resolved) {
    return <div className="p-8 text-sm text-zinc-300">Missing invite token.</div>;
  }

  return <InviteAcceptPanel token={resolved} />;
}
