'use client';

import { FormEvent, useEffect, useState } from 'react';

type Source = { id: number; kind: 'url' | 'text'; url: string | null; title: string; content: string; content_type: string | null; collected_at: string };
type Pattern = { id: number; label: string; pattern: string; created_at: string };
type Mode = 'url' | 'bulk' | 'pattern' | 'text';

export default function KnowledgeCollectorPage() {
  const [mode, setMode] = useState<Mode>('url');
  const [sources, setSources] = useState<Source[]>([]);
  const [patterns, setPatterns] = useState<Pattern[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const [sourceResponse, patternResponse] = await Promise.all([fetch('/api/knowledge/sources'), fetch('/api/knowledge/patterns')]);
    if (sourceResponse.ok) setSources(await sourceResponse.json());
    if (patternResponse.ok) setPatterns(await patternResponse.json());
  };
  useEffect(() => { void refresh(); }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    setBusy(true); setMessage('');
    const form = new FormData(formElement);
    const payload = mode === 'text'
      ? { type: 'text', title: form.get('title'), content: form.get('content') }
      : mode === 'bulk'
        ? { type: 'urls', urls: String(form.get('urls') ?? '').split(/\r?\n/).map((url) => url.trim()).filter(Boolean) }
        : mode === 'pattern'
          ? { type: 'pattern', label: form.get('label'), pattern: form.get('pattern'), start: Number(form.get('start')), end: Number(form.get('end')) }
          : { type: 'url', url: form.get('url') };
    try {
      const response = await fetch('/api/knowledge/collect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Collection failed');
      setMessage(`Collected ${result.collected} source${result.collected === 1 ? '' : 's'}${result.failed?.length ? `; ${result.failed.length} failed` : ''}.`);
      formElement.reset();
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Collection failed');
    } finally { setBusy(false); }
  };

  return (
    <main className="container mx-auto max-w-6xl p-6">
      <a href="/" className="text-sm text-blue-700 underline">← Business collector</a>
      <h1 className="mt-3 text-3xl font-bold">Universal Knowledge Collector</h1>
      <p className="mt-2 max-w-3xl text-gray-600">Capture readable web pages, URL batches, numbered URL patterns, and your own notes into a local SQLite knowledge store.</p>
      <p className="mt-2 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Collection accepts public HTTP(S) text sources only. Private-network URLs, credentials, redirects, unsupported media, and sources over 2 MB are rejected.</p>

      <div className="mt-6 flex flex-wrap gap-2" role="tablist" aria-label="Collection tool">
        {(['url', 'bulk', 'pattern', 'text'] as Mode[]).map((item) => <button key={item} type="button" onClick={() => setMode(item)} className={`rounded px-3 py-2 capitalize ${mode === item ? 'bg-blue-700 text-white' : 'bg-gray-200'}`}>{item === 'url' ? 'Web page' : item === 'bulk' ? 'URL list' : item === 'pattern' ? 'URL pattern' : 'Paste text'}</button>)}
      </div>

      <form className="mt-4 rounded border bg-white p-4" onSubmit={submit}>
        {mode === 'url' && <label className="block font-medium">Public page URL<input data-testid="knowledge-url" required name="url" type="url" placeholder="https://example.org/article" className="mt-1 block w-full rounded border p-2" /></label>}
        {mode === 'bulk' && <label className="block font-medium">One public URL per line (up to 50)<textarea data-testid="knowledge-urls" required name="urls" rows={8} placeholder={'https://example.org/one\nhttps://example.org/two'} className="mt-1 block w-full rounded border p-2 font-mono text-sm" /></label>}
        {mode === 'pattern' && <div className="grid gap-3 md:grid-cols-3"><label className="font-medium md:col-span-3">URL template, using {'{n}'}<input data-testid="knowledge-pattern" required name="pattern" type="url" placeholder="https://example.org/page/{n}" className="mt-1 block w-full rounded border p-2" /></label><label>Label<input name="label" placeholder="Example pages" className="mt-1 block w-full rounded border p-2" /></label><label>Start<input required name="start" type="number" min="0" defaultValue="1" className="mt-1 block w-full rounded border p-2" /></label><label>End (max 50 URLs)<input required name="end" type="number" min="0" defaultValue="10" className="mt-1 block w-full rounded border p-2" /></label></div>}
        {mode === 'text' && <div className="space-y-3"><label className="block font-medium">Title<input data-testid="knowledge-title" required name="title" className="mt-1 block w-full rounded border p-2" /></label><label className="block font-medium">Knowledge text<textarea data-testid="knowledge-content" required name="content" rows={10} className="mt-1 block w-full rounded border p-2" /></label></div>}
        <button data-testid="collect-submit" disabled={busy} className="mt-4 rounded bg-blue-700 px-4 py-2 text-white disabled:opacity-50">{busy ? 'Collecting…' : 'Collect knowledge'}</button>
        {message && <p role="status" className="mt-3 text-sm">{message}</p>}
      </form>

      <section className="mt-8">
        <div className="flex items-center justify-between"><h2 className="text-xl font-semibold">Collected sources</h2><button onClick={() => void refresh()} className="rounded bg-gray-200 px-3 py-1">Refresh</button></div>
        <div className="mt-3 space-y-3" data-testid="knowledge-sources">
          {sources.length === 0 ? <p className="rounded border p-4 text-gray-500">No knowledge collected yet.</p> : sources.map((source) => <article key={source.id} className="rounded border p-4"><div className="flex gap-2 text-xs text-gray-500"><span className="rounded bg-gray-100 px-2 py-1 uppercase">{source.kind}</span><time>{new Date(source.collected_at).toLocaleString()}</time></div><h3 className="mt-2 font-semibold">{source.title}</h3>{source.url && <a className="text-sm text-blue-700 underline" href={source.url} target="_blank" rel="noreferrer">{source.url}</a>}<p className="mt-2 line-clamp-3 whitespace-pre-wrap text-sm text-gray-700">{source.content}</p></article>)}
        </div>
      </section>
      <section className="mt-8">
        <h2 className="text-xl font-semibold">Saved URL patterns</h2>
        {patterns.length === 0 ? <p className="mt-3 text-sm text-gray-500">Numbered templates are saved here after their first collection.</p> : <ul className="mt-3 space-y-2" data-testid="knowledge-patterns">{patterns.map((pattern) => <li key={pattern.id} className="rounded border p-3"><strong>{pattern.label}</strong><code className="ml-2 break-all text-sm text-gray-600">{pattern.pattern}</code></li>)}</ul>}
      </section>
    </main>
  );
}
