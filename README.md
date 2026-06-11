# Pleasant Lake Storage — Website

Static site for pleasantlakestorage.com. No build step — just upload the files.

## Files
- `index.html` — homepage (units/prices, gated + outdoor parking features, FAQ, map)
- `tenant-protection.html` · `contact-us.html`
- `css/styles.css` — all styling
- `sitemap.xml` · `robots.txt` — for Google
- `images/` — **ADD YOUR PHOTOS HERE.** The hero expects `images/hero.jpg` (a wide photo of the gated facility — the gate/fence with units behind it is ideal). Until added, the hero shows a solid blue background, which still looks clean.

## Deploy (pick one)
1. **Vercel** (same as Long Lake site): vercel.com → New Project → drag this folder in → point pleasantlakestorage.com at it.
2. **Netlify:** app.netlify.com/drop → drag the folder.
3. **Existing WordPress host:** replace the WP site by uploading these files to the web root.

## Get #1 on Google — do these after launch (in order of impact)
1. **Google Business Profile** (biggest lever in a town of 300 — most rentals come from the map pack):
   - Claim/verify the listing for 2475 County Rd 45 NW, Hackensack MN
   - Categories: Self-storage facility (primary) + Boat storage facility + RV storage facility
   - Set website to pleasantlakestorage.com, hours to "Open 24 hours," add 10+ real photos (gate, fence, outdoor parking, clean units)
   - Ask every happy tenant for a Google review (text them the review link). 10+ reviews beats every competitor in town.
2. **Google Search Console:** search.google.com/search-console → add pleasantlakestorage.com → submit sitemap.xml. This gets the new pages indexed within days and shows you exactly which searches you rank for.
3. **Update prices** when they change — edit the table in index.html, or re-run `rental-center-scraper.js` (in the Self Storage folder) to pull current prices/availability from storEDGE.
4. **Real reviews only** — when Google reviews come in, we can add the best ones to the homepage with links, like the Long Lake site does.

## Already built in
- Title/meta targeting "storage units Hackensack MN" + boat/RV/lake keywords
- SelfStorage + FAQPage schema (rich results in Google)
- Canonical URLs, Open Graph, sitemap, robots, mobile responsive, fast (no frameworks)
- Every CTA → storEDGE rental center (rent, login, pay)
