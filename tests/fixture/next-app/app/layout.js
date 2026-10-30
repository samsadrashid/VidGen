import Link from 'next/link';
export const metadata = { title: 'Next fixture' };
export default function RootLayout({ children }) {
  return (<html lang="en"><body style={{ fontFamily: 'system-ui', margin: 0, background: '#f8fafc' }}>
    <nav style={{ background: '#111827', color: '#fff', padding: 16, display: 'flex', gap: 16 }}>
      <b>Acme</b><Link href="/" style={{ color: '#fff' }}>Home</Link><Link href="/pricing" style={{ color: '#fff' }} id="nav-pricing">Pricing</Link>
      <Link href="/blog/hello-world" style={{ color: '#fff' }} id="nav-post">Blog</Link><Link href="/broken" style={{ color: '#fff' }} id="nav-broken">Broken</Link>
    </nav><main style={{ padding: 32 }}>{children}</main></body></html>);
}
