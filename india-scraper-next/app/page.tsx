'use client';

import { useState, useEffect, useRef } from 'react';

type ViewMode = 'refined' | 'history';

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

  const fetchData = async () => {
    const endpoint = view === 'refined' ? '/api/refined-results' : '/api/history-results';
    const url = category ? `${endpoint}?category=${encodeURIComponent(category)}` : endpoint;
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
        body: JSON.stringify({ category }),
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
  }, [view, category]);

  const getDateField = (item: ResultItem) => {
    return view === 'refined' ? item.last_updated : item.scraped_at;
  };

  return (
    <main className="container mx-auto p-4 max-w-6xl">
      <h1 className="text-3xl font-bold mb-2">🇮🇳 India Business Scraper</h1>
      <p className="text-gray-600 mb-4">Scrape Google Maps for any category across all Indian districts.</p>

      <div className="flex flex-wrap gap-3 mb-4">
        <input
          type="text"
          className="flex-1 min-w-[200px] p-2 border rounded"
          placeholder="e.g., plumbers, dentists"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        />
        <button
          onClick={startScrape}
          disabled={loading}
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
        <button onClick={fetchData} className="ml-auto px-3 py-1 bg-gray-200 rounded hover:bg-gray-300">
          Refresh
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full bg-white border">
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
    </main>
  );
}
