// Route table mirrors server.mjs pages (discovery reads this; server serves the HTML).
export const routes = [
  { path: '/', element: 'Home' },
  { path: '/signup', element: 'Signup' },
  { path: '/dashboard', element: 'Dashboard' },
  { path: '/settings', element: 'Settings' },
];
