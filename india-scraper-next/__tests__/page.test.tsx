import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import Home from '@/app/page';

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

function jsonResponse(data: any, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    json: () => Promise.resolve(data),
  } as Response);
}

describe('Home page', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockFetch.mockImplementation((url: string) => {
      if (url.startsWith('/api/refined-results')) return jsonResponse([]);
      if (url.startsWith('/api/history-results')) return jsonResponse([]);
      return jsonResponse({});
    });
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('renders heading and input', async () => {
    render(<Home />);
    expect(screen.getByText(/India Business Scraper/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/plumbers, dentists/i)).toBeInTheDocument();
  });

  it('fetches refined results on mount', async () => {
    render(<Home />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith('/api/refined-results'));
  });

  it('alerts when starting scrape without a category', async () => {
    const alertSpy = jest.spyOn(window, 'alert').mockImplementation(() => {});
    render(<Home />);
    fireEvent.click(screen.getByText('Start Scraping'));
    expect(alertSpy).toHaveBeenCalledWith('Enter a category');
    alertSpy.mockRestore();
  });

  it('starts a scrape and shows progress', async () => {
    mockFetch.mockImplementation((url: string, opts?: any) => {
      if (url === '/api/start-scrape') {
        return jsonResponse({ jobId: 'j1', total: 5, message: 'Scraping started' });
      }
      if (url === '/api/job/j1') {
        return jsonResponse({ jobId: 'j1', total: 5, completed: 2, status: 'running', startTime: '' });
      }
      return jsonResponse([]);
    });

    render(<Home />);
    fireEvent.change(screen.getByPlaceholderText(/plumbers, dentists/i), {
      target: { value: 'plumbers' },
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Start Scraping'));
    });

    await waitFor(() => expect(screen.getByText(/Progress: 0 \/ 5/)).toBeInTheDocument());
    expect(screen.getByText(/running/i)).toBeInTheDocument();
  });

  it('polls job progress and stops on completion', async () => {
    let jobCalls = 0;
    mockFetch.mockImplementation((url: string) => {
      if (url === '/api/start-scrape') {
        return jsonResponse({ jobId: 'j9', total: 2, message: 'started' });
      }
      if (url === '/api/job/j9') {
        jobCalls++;
        // Complete on the first poll so we deterministically stop
        return jsonResponse({ jobId: 'j9', total: 2, completed: 2, status: 'completed', startTime: '' });
      }
      return jsonResponse([]);
    });

    render(<Home />);
    fireEvent.change(screen.getByPlaceholderText(/plumbers, dentists/i), {
      target: { value: 'x' },
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Start Scraping'));
    });

    // Advance one poll interval; async timer flush lets checkProgress run,
    // set status to 'completed', and clear the interval.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3000);
    });

    expect(jobCalls).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/completed/i)).toBeInTheDocument();
  });

  it('switches between refined and history views', async () => {
    render(<Home />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith('/api/refined-results'));

    fireEvent.click(screen.getByText('History (All)'));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith('/api/history-results'));

    fireEvent.click(screen.getByText('Refined (Unique)'));
    await waitFor(() =>
      expect(mockFetch.mock.calls.some((c) => c[0] === '/api/refined-results')).toBe(true)
    );
  });

  it('includes category in fetch URL when set', async () => {
    render(<Home />);
    fireEvent.change(screen.getByPlaceholderText(/plumbers, dentists/i), {
      target: { value: 'cafes' },
    });
    await waitFor(() =>
      expect(
        mockFetch.mock.calls.some(
          (c) => typeof c[0] === 'string' && c[0].includes('category=cafes')
        )
      ).toBe(true)
    );
  });

  it('renders "No data found" when results are empty', async () => {
    render(<Home />);
    await waitFor(() => expect(screen.getByText('No data found')).toBeInTheDocument());
  });

  it('renders result rows with business data', async () => {
    const item = {
      id: 1,
      category: 'plumbers',
      district_id: 1,
      district_name: 'Pune',
      business_name: 'Best Plumbing',
      contact_person: 'Raj',
      phone: '9876543210',
      address: '123 MG Road',
      website: 'https://example.com',
      last_updated: '2026-01-01T00:00:00Z',
    };
    mockFetch.mockImplementation((url: string) => {
      if (url.startsWith('/api/refined-results')) return jsonResponse([item]);
      return jsonResponse([]);
    });
    render(<Home />);
    await waitFor(() => expect(screen.getByText('Best Plumbing')).toBeInTheDocument());
    expect(screen.getByText('Raj')).toBeInTheDocument();
    expect(screen.getByText('9876543210')).toBeInTheDocument();
    expect(screen.getByText('Pune')).toBeInTheDocument();
    expect(screen.getByText('Link')).toHaveAttribute('href', 'https://example.com');
  });

  it('shows dash for missing optional fields', async () => {
    const item = {
      id: 2,
      category: 'x',
      district_id: 1,
      district_name: 'Goa',
      business_name: 'Solo Shop',
      contact_person: null,
      phone: null,
      address: null,
      website: null,
      last_updated: null,
    };
    mockFetch.mockImplementation((url: string) => {
      if (url.startsWith('/api/refined-results')) return jsonResponse([item]);
      return jsonResponse([]);
    });
    render(<Home />);
    await waitFor(() => expect(screen.getByText('Solo Shop')).toBeInTheDocument());
    const dashes = screen.getAllByText('-');
    expect(dashes.length).toBeGreaterThanOrEqual(4);
  });

  it('handles scrape start error gracefully', async () => {
    const alertSpy = jest.spyOn(window, 'alert').mockImplementation(() => {});
    mockFetch.mockImplementation((url: string) => {
      if (url === '/api/start-scrape') return jsonResponse({ error: 'No districts found' });
      return jsonResponse([]);
    });
    render(<Home />);
    fireEvent.change(screen.getByPlaceholderText(/plumbers, dentists/i), {
      target: { value: 'x' },
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Start Scraping'));
    });
    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining('No districts found'))
    );
    alertSpy.mockRestore();
  });
});
