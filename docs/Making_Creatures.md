# Making creatures

ImWeb's creatures live in the **3D Scene** workspace ▸ **Creature**. You can make
your own from any of them, save it as a file, and share it. This page explains
how, and where to find creatures other people have made.

## What a creature file is

A creature file ends in `.imcreature`. It is a small text file that holds:

- a **name**;
- the **animal it is built on** (an Octopus, Pods, a Cobra…);
- a list of **movements**, each one a set of numbers for that animal's own
  controls;
- a few **colours**.

It holds no program code. That is deliberate: a creature file from a stranger
can change how an animal moves and looks, and nothing else. It cannot harm
your projects or read anything on your computer.

The limit that comes with this: a file re-choreographs and re-colours an
animal ImWeb already has. It cannot bring a new kind of body. New bodies are
written as code — see *Building a new animal* at the end.

## Export: start from an animal

1. Open **3D Scene** ▸ **Creature**, switch **Creature** on and pick an
   **Animal**.
2. Click **Export…**. ImWeb saves a file such as `My Pods.imcreature`.

The file contains every movement that animal has, so it is a complete, working
starting point.

## Edit the file

Open the file in any text editor. It looks like this:

```json
{
  "format": "imweb-creature",
  "version": 1,
  "name": "Blue Pods",
  "base": "pods",
  "controls": { "eight": 0, "knot": 0, "hair": 1, "wv": 3, "swell": 1 },
  "wholeNumberControls": ["wv", "turn", "drift", "roll"],
  "moves": [
    { "name": "Calm Eight", "desc": "a quiet figure eight",
      "values": { "eight": 1, "wv": 1, "swell": 0.3 } }
  ],
  "look": {
    "limb": "#dfe9f5",
    "roughness": 0.3,
    "colours": { "uIris": "#3fb7c9", "uVein": "#7a4fd0" }
  }
}
```

- **`name`** — what the creature is called. Up to 24 characters.
- **`base`** — the animal it is built on. Leave this as exported.
- **`controls`** — a reference list: every control this animal has, with its
  resting value. ImWeb writes it on export so you can see what there is to
  change. It is ignored on import.
- **`wholeNumberControls`** — the controls that must be whole numbers. They
  count things that happen a whole number of times per loop (how many times a
  wave runs round, how many turns), which is what lets every movement loop
  without a seam. ImWeb rounds them for you.
- **`moves`** — the movements, in the order they appear in the **Movement**
  menu. Each has a `name`, an optional `desc`, and `values`: the controls that
  differ from their resting value in this movement. A control you leave out
  keeps its resting value. Up to 40 movements.
- **`look`** — colours as `#rrggbb`. `limb` is the skin, `body` the core,
  `under` the underside, where the animal has them. `roughness` runs from 0
  (glossy) to 1 (matte). `colours` holds the animal's own extra colours, where
  it has any (Pods: `uIris` for the eyes, `uVein` for the veins).

**How to work:** change one number, save, import, look. The exported movements
show which controls matter and what size of number each one takes. Copy a
movement, rename it and change two or three values to make a new one.

Anything ImWeb does not recognise — a control the animal does not have, a
value that is not a number — is left out when the file is loaded. A mistake
cannot break ImWeb; at worst a movement looks odd.

## Import

1. Click **Import…** in the Creature panel and choose a `.imcreature` file.
2. ImWeb switches to the animal the creature is built on and shows your
   movements in the **Movement** menu.

The panel shows **Custom creature: _name_** while one is loaded. It stays
loaded when you close and reopen ImWeb in the same browser. **Remove** goes
back to the animal's own movements and colours.

Two things to know:

- **One custom creature at a time.** It replaces the movements and colours of
  the animal it is built on until you remove it. The other animals are not
  affected.
- **Saved states remember the animal and the movement number, not the file.**
  A Display State saved with a custom creature recalls "Pods, movement 3". On
  a computer that does not have your file loaded, that is Pods' own third
  movement. To perform with a custom creature somewhere else, take the file
  with you and import it there.

## Where to find creatures, and where to share yours

- **Examples that come with ImWeb:** the
  [Creatures folder](https://github.com/imweb-project/ImWeb/tree/main/public/Creatures)
  in the ImWeb repository. *Blue Pods* is there to try: download it and import
  it.
- **Creatures made by others, and a place for yours:**
  [ImWeb Discussions](https://github.com/imweb-project/ImWeb/discussions).
  Attach your `.imcreature` file to a post, with a line about which animal it
  is built on.

Because a creature file is only data, it is safe to try one from someone you
do not know.

## Building a new animal

A new body — its skeleton, its skin, the way it moves — is written as code,
in the ImWeb source: two files per animal in `tools/creature/`, tried out on
the creature test page (`tools/creature/creature.html`). The comments at the
top of `tools/creature/core.js` and `engine.js` describe what an animal must
provide, and `node tools/creature/seam-check.mjs` checks that every movement
loops without a seam. A new animal joins ImWeb through a contribution to the
repository, not through a file.
