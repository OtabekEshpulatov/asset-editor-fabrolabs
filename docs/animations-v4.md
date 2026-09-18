# Animations v4 — the Moonykids cast

The **Animations v4** tab shows every character that Moonykids stories put on
stage, with all of that character's animations. Hovering the tab says so:

> Moonykids. What Happened Today, Bedtime Stories, Grow and Learn animations.

Moonykids is made of three products, which live in
[story-engine-v2](https://github.com/FabroLabs/story-engine-v2) as three folders:

| Tab section | story-engine-v2 folder | What it is |
| --- | --- | --- |
| What Happened Today | `what_happened_today/` | Stories about the child's day, cast from a fixed set of family looks |
| Bedtime Stories | `bedtime/` | Bedtime stories |
| Grow and Learn | `learn/` | Lessons (ABC, counting, animals) |

The tab has one section per product, and each section is that product's whole
cast. A character used by two products shows up in both sections; today that
is `boy_kid`, who is in What Happened Today and in Bedtime Stories.

## Nothing here is a copy

Every card is an ordinary library character, the same one you see in the
**Sprites** tab, with the same sprite sheets. v4 only chooses *which*
characters to show and groups them by product. So:

- An animation added, retimed or disabled in the Sprites tab (or through
  **Manage actions** here) is the same change in both tabs.
- Unticking **enabled** in the v4 popup disables the character **everywhere**,
  exactly as it would in the Sprites tab. It is not a "hide from v4" switch.
- **Rename is switched off** in this tab. The story engine looks characters up
  by these exact slugs, so a renamed character would drop out of this tab and
  stop matching what the stories ask for.
- There is no **+ Add** button. A character joins the tab by being added to the
  cast list (below), not by uploading here.

## The cast

Checked against story-engine-v2 on 2026-09-18 (commit `7793b7b`).

### What Happened Today — 19

Every WHT story casts its characters from the same pools, defined in
`what_happened_today/avatars.json` (`slots[].avatar_ids`):

| Role in the story | Characters |
| --- | --- |
| The child, and their sibling or friend | `boy_kid`, `boy_kid_asian`, `boy_kid_black`, `girl_kid`, `girl_kid_asian`, `girl_kid_black`, `girl_kid_muslim` |
| Mum | `woman_middle_age`, `woman_middle_age_asian`, `woman_middle_age_black` |
| Dad | `man_adult`, `man_adult_asian`, `man_adult_black` |
| Granny | `woman_senior` |
| Grandpa | `man_senior` |
| Pet | `cat`, `dog`, `rabbit`, `robin` |

### Bedtime Stories — 1

`boy_kid`, from `bedtime/stories/*/template.json` (`cast[].avatar_ids`). There
is one bedtime story so far, and its hero is `boy_kid`.

### Grow and Learn — 2

From `learn/stories/*.json` (`authored.cast`):

- `squirrel` ("Nutmeg"), in the ABC lessons
- `clownfish` ("Bibo"), in the ocean counting lessons (it is also listed in the
  two farm-animal lessons, but never appears on screen there)

### Two characters go by other names in What Happened Today

The tab uses **library** slugs, because those are what the sprite sheets are
stored under. What Happened Today calls two of its characters something else:

| What Happened Today says | Library slug (what the tab shows) |
| --- | --- |
| `grandma_senior` | `woman_senior` |
| `grandpa_senior` | `man_senior` |

The mapping is `ALIASES` in `what_happened_today/animation_setup.py`.

The library also has `woman_adult`, `woman_adult_asian` and `woman_adult_black`.
Those are an older set of mums with fewer animations. What Happened Today uses
the `woman_middle_age*` characters, which have the story motions (talking,
carrying, sitting, sport…), so those are the ones in the cast.

### Left out, on purpose

Only characters that exist as library sprites can be shown here:

- **The bedtime dragon** was drawn for its one story and is not a library
  character. The library's `dragon` and `baby_dragon` are different characters,
  and no Moonykids story uses them.
- **Grow and Learn's farm animals** (cow, sheep, goat and so on) are SVG
  pictures stored under `objects/animals_farm/` in the bucket, not animated
  characters. The editor doesn't list them anywhere yet.

## Updating the cast

When a Moonykids story starts using a new character:

1. Find its slug in story-engine-v2, in the file listed for that product above.
2. Look it up in the **Sprites** tab. If the story uses a different name from
   the library, use the library's (see the table of other names above).
3. Add the slug to that product's list in `CAST` in
   [`backend/app/sprites_v4.py`](../backend/app/sprites_v4.py). The order there
   is the order the cards appear in.
4. Deploy. The tab reads the list on every load, so there is nothing else to
   refresh.

A slug that doesn't exist in the library, or has no sprite sheets yet, is
skipped silently rather than shown as a broken card. So if a character you
added doesn't appear, check the Sprites tab for it first.

## How it is wired

| Piece | Where |
| --- | --- |
| The cast, and how each product section is built | [`backend/app/sprites_v4.py`](../backend/app/sprites_v4.py) |
| How one character becomes a card (shared with Animations v3) | `character_item` in [`backend/app/sprites_v3.py`](../backend/app/sprites_v3.py) |
| The endpoint | `GET /api/v4/assets/catalog?kind=animation_v4` (add `&include_disabled=true` for disabled characters and actions) |
| The tab, its tooltip, and the popup's rename lock | [`frontend/src/pages/Assets.tsx`](../frontend/src/pages/Assets.tsx) |

The endpoint answers in the same shape as every other gallery tab:
`{kind, total, categories: [{name, count, items}]}`, with one category per
product.

## How it differs from v2 and v3

| Tab | What it shows | Where the list comes from |
| --- | --- | --- |
| Animations v2 | Regenerated sprite sheets, stored separately under `sprites-v2/` | Whatever is in that folder |
| Animations v3 | A hand-picked subset of library characters | `manifests/v3_curated.json` in the bucket |
| Animations v4 | The characters Moonykids stories use | The `CAST` list in code, copied from story-engine-v2 |

v4 keeps its list in code rather than in the bucket because it mirrors another
repo's code: it should change when a story changes and go through review, not
be edited in place.
