export async function load({ params }) { await new Promise((r) => setTimeout(r, 800)); return { slug: params.slug }; }
