# Vitrina: product one-pager

**What it is:** Display your science fiction paperbacks by their spines

**Who it is for:** One collector with a wall of Spanish-language science fiction
paperbacks from the Ediciones B lines, whose covers are hard to find scanned
anywhere except a volunteer catalogue, and who has never had a way to look at
the collection as a collection.

**Register:** product (a tool someone uses), not brand (a page someone visits).

**The scene:** Late evening, laptop, one person going back and forth between
this page and a physical shelf across the room, checking which volume of a saga
is missing before an online order.

**What done looks like:** A session ends with the shelf matching the wall: every
book standing at its real proportions, and any book found missing either added
to the shelf or written down.

## What it is not

Not a reading tracker, not a wishlist app, not a marketplace. It does not rate,
review, or recommend. The only question it answers is what the collection looks
like and what is missing from it.

## Constraints that shaped it

- **The images belong to someone else.** Cover and spine scans are hotlinked
  from tercerafundacion.net, which serves them with a one-year cache header and
  no hotlink protection. Nothing is copied into this repo, and the back cover
  copy is not stored at all: the drawer links to the source record instead.
- **The catalogue has no API.** Everything is scraped politely and cached, so
  the data files are built offline and the page itself makes no request to the
  catalogue except for images.
- **A spine can be missing.** Eight of the thirty-nine editions on this shelf
  have no scan. Those get a drawn spine that is deliberately flat and lettered,
  because a shelf with holes in it is worse than a shelf that admits them.
