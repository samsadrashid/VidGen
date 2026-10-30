<script>let { children } = $props();</script>
<nav style="background:#ff3e00;color:#fff;padding:16px;display:flex;gap:16px"><b>Kit</b><a href="/" style="color:#fff">Home</a><a href="/about" style="color:#fff" id="nav-about">About</a><a href="/blog/hello-world" style="color:#fff" id="nav-post">Blog</a><a href="/broken" style="color:#fff" id="nav-broken">Broken</a></nav>
<main style="padding:32px">{@render children()}</main>
