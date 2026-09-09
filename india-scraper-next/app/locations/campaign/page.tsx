export default function CampaignExplorer() {
  return <main className="h-screen flex flex-col bg-slate-950 text-slate-100">
    <header className="p-3 flex flex-wrap gap-4 items-center text-sm">
      <a className="underline" href="/locations">← Location catalogue</a>
      <strong>TLPS campaign explorer</strong>
      <span>Planning only · edits stay in this browser · source snapshots remain unchanged</span>
    </header>
    <iframe title="TLPS campaign map and registry" src="/locations/campaign/explorer" className="flex-1 w-full border-0 bg-white" />
  </main>;
}
