import './globals.css';

export const metadata = {
  title: 'India Business Scraper',
  description: 'Scrape Google Maps across all Indian districts',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
