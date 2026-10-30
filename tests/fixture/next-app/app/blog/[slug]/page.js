export default async function Post({ params }) {
  await new Promise((r) => setTimeout(r, 1500)); // slow data: loading.js shows meanwhile
  return <article><h1 data-testid="post">Post: {params.slug}</h1><p>Rendered by a dynamic App Router segment.</p></article>;
}
