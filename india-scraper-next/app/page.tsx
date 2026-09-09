'use client';

import { useState, useEffect, useRef } from 'react';

type ViewMode = 'refined' | 'history' | 'knowledge';

interface KnowledgeResult {
  score: number;
  content: string;
  source_type: string;
  source_key: string;
  title: string | null;
  metadata: any;
}

interface ResultItem {
  id: number;
  category: string;
  district_id: number;
  district_name: string;
  business_name: string;
  contact_person: string | null;
  phone: string | null;
  address: string | null;
  website: string | null;
  first_seen?: string;
  last_updated?: string;
  scraped_at?: string;
}

export default function Home() {
  const [category, setCategory] = useState('');
  const [view, setView] = useState<ViewMode>('refined');
  const [results, setResults] = useState<ResultItem[]>([]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState({ total: 0, completed: 0, status: 'idle' });
  const [loading, setLoading] = useState(false);
  const pollInterval = useRef<NodeJS.Timeout | null>(null);
  const jobIdRef = useRef<string | null>(null);

  // Knowledge panel state
  const [knowledgeQuery, setKnowledgeQuery] = useState('');
  const [knowledgeResults, setKnowledgeResults] = useState<KnowledgeResult[]>([]);
  const [knowledgeLoading, setKnowledgeLoading] = useState(false);
  const [ingestType, setIngestType] = useState<'text' | 'url'>('text');
  const [ingestKey, setIngestKey] = useState('');
  const [ingestTitle, setIngestTitle] = useState('');
  const [ingestContent, setIngestContent] = useState('');
  const [ingestUrl, setIngestUrl] = useState('');
  const [ingestMessage, setIngestMessage] = useState('');
  const [refreshMessage, setRefreshMessage] = useState('');

  const [district, setDistrict] = useState('');

  const fetchData = async () => {
    const endpoint = view === 'refined' ? '/api/refined-results' : '/api/history-results';
    const url = category ? `${endpoint}?category=${encodeURIComponent(category)}&district=${encodeURIComponent(district)}` : endpoint;
    try {
      const res = await fetch(url);
      const data = await res.json();
      setResults(data);
    } catch (error) {
      console.error('Fetch error:', error);
    }
  };

  const startScrape = async () => {
    if (!category) return alert('Enter a category');
    setLoading(true);
    try {
      const res = await fetch('/api/start-scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, district }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setJobId(data.jobId);
      jobIdRef.current = data.jobId;
      setProgress({ total: data.total, completed: 0, status: 'running' });
      if (pollInterval.current) clearInterval(pollInterval.current);
      pollInterval.current = setInterval(checkProgress, 3000);
    } catch (err: any) {
      alert('Error: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  const checkProgress = async () => {
    const currentJobId = jobIdRef.current;
    if (!currentJobId) return;
    try {
      const res = await fetch(`/api/job/${currentJobId}`);
      const data = await res.json();
      if (data.error) return;
      setProgress({ total: data.total, completed: data.completed, status: data.status });
      if (data.status === 'completed' || data.status === 'failed') {
        if (pollInterval.current) clearInterval(pollInterval.current);
        pollInterval.current = null;
        fetchData();
      }
    } catch (e) { /* ignore */ }
  };

  useEffect(() => {
    fetchData();
    return () => {
      if (pollInterval.current) clearInterval(pollInterval.current);
    };
  }, [view, category, district]);

  const getDateField = (item: ResultItem) => {
    return view === 'refined' ? item.last_updated : item.scraped_at;
  };

  const searchKnowledge = async () => {
    if (!knowledgeQuery) return;
    setKnowledgeLoading(true);
    try {
      const res = await fetch(`/api/knowledge/search?q=${encodeURIComponent(knowledgeQuery)}&topK=5`);
      const data = await res.json();
      setKnowledgeResults(data.results || []);
    } catch (error) {
      console.error('Knowledge search error:', error);
    } finally {
      setKnowledgeLoading(false);
    }
  };

  const ingestKnowledge = async () => {
    setIngestMessage('');
    try {
      const body: any = {
        type: ingestType,
        key: ingestKey || (ingestType === 'url' ? ingestUrl : ingestTitle || 'untitled'),
        title: ingestTitle || ingestKey,
      };
      if (ingestType === 'url') body.url = ingestUrl;
      else body.content = ingestContent;

      const res = await fetch('/api/knowledge/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setIngestMessage(`Ingested ${data.chunks} chunk(s) for "${data.source_key}"`);
      setIngestContent('');
      setIngestUrl('');
    } catch (err: any) {
      setIngestMessage('Error: ' + err.message);
    }
  };

  const refreshKnowledge = async () => {
    setRefreshMessage('Refreshing...');
    try {
      const res = await fetch('/api/knowledge/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: category || undefined }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setRefreshMessage(`Refreshed ${data.ingested} business record(s)`);
    } catch (err: any) {
      setRefreshMessage('Error: ' + err.message);
    }
  };

  return (
    <main className="container mx-auto p-4 max-w-6xl">
      <h1 className="text-3xl font-bold mb-2">🇮🇳 India Business Scraper/Reflector</h1>
      <p className="text-gray-600 mb-4">Scrape/Reflect Google Maps for any category across all Indian districts.</p>
      <a href="/locations" className="mb-4 mr-5 inline-block text-sm text-teal-700 underline">Open Location Map & Search →</a>
      <a href="/knowledge" className="mb-4 inline-block text-sm text-blue-700 underline">Open Universal Knowledge Collector →</a>

      <div className="flex flex-wrap gap-3 mb-4">
        <input
          type="text"
          data-testid="category-input"
          className="flex-1 min-w-[200px] p-2 border rounded"
          placeholder="e.g., plumbers, dentists"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        />
        <input
          type="text"
          data-testid="district-input"
          className="flex-1 min-w-[200px] p-2 border rounded"
          placeholder="e.g., East Delhi (optional)"
          value={district}
          onChange={(e) => setDistrict(e.target.value)}
        />
        <button
          onClick={startScrape}
          disabled={loading}
          data-testid="start-button"
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? 'Starting...' : 'Start Scraping'}
        </button>
      </div>

      {progress.status !== 'idle' && (
        <div className="mb-4 p-3 border rounded bg-gray-50">
          <div className="flex justify-between text-sm mb-1">
            <span>Progress: {progress.completed} / {progress.total}</span>
            <span>Status: <span className={`font-semibold ${progress.status === 'completed' ? 'text-green-600' : 'text-yellow-600'}`}>{progress.status}</span></span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-2.5">
            <div className="bg-green-600 h-2.5 rounded-full transition-all" style={{ width: `${progress.total > 0 ? (progress.completed / progress.total * 100) : 0}%` }}></div>
          </div>
        </div>
      )}

      <div className="flex gap-2 mb-3">
        <button
          onClick={() => setView('refined')}
          className={`px-3 py-1 rounded ${view === 'refined' ? 'bg-blue-600 text-white' : 'bg-gray-200'}`}
        >
          Refined (Unique)
        </button>
        <button
          onClick={() => setView('history')}
          className={`px-3 py-1 rounded ${view === 'history' ? 'bg-blue-600 text-white' : 'bg-gray-200'}`}
        >
          History (All)
        </button>
        <button
          onClick={() => setView('knowledge')}
          className={`px-3 py-1 rounded ${view === 'knowledge' ? 'bg-blue-600 text-white' : 'bg-gray-200'}`}
        >
          Knowledge
        </button>
        <button onClick={fetchData} className="ml-auto px-3 py-1 bg-gray-200 rounded hover:bg-gray-300">
          Refresh
        </button>
      </div>

      {view === 'knowledge' && (
        <div className="space-y-6 mb-6">
          <div className="p-4 border rounded bg-white">
            <h2 className="text-lg font-semibold mb-3">Knowledge Search</h2>
            <div className="flex gap-2 mb-2">
              <input
                type="text"
                className="flex-1 p-2 border rounded"
                placeholder="Ask or search the knowledge base..."
                value={knowledgeQuery}
                onChange={(e) => setKnowledgeQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && searchKnowledge()}
              />
              <button
                onClick={searchKnowledge}
                disabled={knowledgeLoading}
                className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {knowledgeLoading ? 'Searching...' : 'Search'}
              </button>
            </div>
            {knowledgeResults.length > 0 && (
              <div className="space-y-3 mt-4">
                {knowledgeResults.map((r, idx) => (
                  <div key={idx} className="p-3 bg-gray-50 border rounded">
                    <div className="flex justify-between text-sm text-gray-500 mb-1">
                      <span className="font-medium">{r.title || r.source_key}</span>
                      <span>score: {r.score.toFixed(3)}</span>
                    </div>
                    <pre className="whitespace-pre-wrap text-sm">{r.content}</pre>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="p-4 border rounded bg-white">
            <h2 className="text-lg font-semibold mb-3">Ingest Knowledge</h2>
            <div className="flex gap-2 mb-3">
              <button
                onClick={() => setIngestType('text')}
                className={`px-3 py-1 rounded ${ingestType === 'text' ? 'bg-blue-600 text-white' : 'bg-gray-200'}`}
              >
                Text
              </button>
              <button
                onClick={() => setIngestType('url')}
                className={`px-3 py-1 rounded ${ingestType === 'url' ? 'bg-blue-600 text-white' : 'bg-gray-200'}`}
              >
                URL
              </button>
            </div>
            <div className="grid gap-3 mb-3">
              <input
                type="text"
                className="p-2 border rounded"
                placeholder="Unique key (optional)"
                value={ingestKey}
                onChange={(e) => setIngestKey(e.target.value)}
              />
              <input
                type="text"
                className="p-2 border rounded"
                placeholder="Title"
                value={ingestTitle}
                onChange={(e) => setIngestTitle(e.target.value)}
              />
              {ingestType === 'url' ? (
                <input
                  type="url"
                  className="p-2 border rounded"
                  placeholder="https://example.com/article"
                  value={ingestUrl}
                  onChange={(e) => setIngestUrl(e.target.value)}
                />
              ) : (
                <textarea
                  className="p-2 border rounded h-32"
                  placeholder="Paste text content here..."
                  value={ingestContent}
                  onChange={(e) => setIngestContent(e.target.value)}
                />
              )}
            </div>
            <button
              onClick={ingestKnowledge}
              className="bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700"
            >
              Ingest
            </button>
            {ingestMessage && <p className="text-sm mt-2 text-gray-700">{ingestMessage}</p>}
          </div>

          <div className="p-4 border rounded bg-white">
            <h2 className="text-lg font-semibold mb-3">Refresh from Scraped Data</h2>
            <p className="text-sm text-gray-600 mb-3">
              Embed refined business records into the knowledge base. Filter by the category above, or leave it blank to refresh all.
            </p>
            <button
              onClick={refreshKnowledge}
              className="bg-purple-600 text-white px-4 py-2 rounded hover:bg-purple-700"
            >
              Refresh Scraped Records
            </button>
            {refreshMessage && <p className="text-sm mt-2 text-gray-700">{refreshMessage}</p>}
          </div>
        </div>
      )}

      {view !== 'knowledge' && (
      <>
      <div className="overflow-x-auto">
        <table data-testid="results-table"  className="min-w-full bg-white border">
          <thead>
            <tr className="bg-gray-100">
              <th className="py-2 px-3 border">District</th>
              <th className="py-2 px-3 border">Business</th>
              <th className="py-2 px-3 border">Contact Person</th>
              <th className="py-2 px-3 border">Phone</th>
              <th className="py-2 px-3 border">Address</th>
              <th className="py-2 px-3 border">Website</th>
              <th className="py-2 px-3 border">{view === 'refined' ? 'Last Updated' : 'Scraped At'}</th>
            </tr>
          </thead>
          <tbody>
            {results.length === 0 ? (
              <tr><td colSpan={7} className="text-center py-4 text-gray-500">No data found</td></tr>
            ) : (
              results.map((item) => (
                <tr key={item.id} className="hover:bg-gray-50">
                  <td className="py-1 px-3 border">{item.district_name}</td>
                  <td className="py-1 px-3 border">{item.business_name}</td>
                  <td className="py-1 px-3 border">{item.contact_person || '-'}</td>
                  <td className="py-1 px-3 border">{item.phone || '-'}</td>
                  <td className="py-1 px-3 border">{item.address || '-'}</td>
                  <td className="py-1 px-3 border">
                    {item.website ? <a href={item.website} target="_blank" className="text-blue-600 underline">Link</a> : '-'}
                  </td>
                  <td className="py-1 px-3 border text-sm">
                    {getDateField(item) ? new Date(getDateField(item)!).toLocaleString() : '-'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="text-xs text-gray-500 mt-2">Showing latest {results.length} records</div>
      </>
      )}
    </main>
  );
}
