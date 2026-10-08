# funground

**Creative coding for learners.** funground is a small Python library for drawing and animation.
You write a short Python file, run it, and a window opens with your picture in it.

It is made for people who are new to programming, and for teachers. It can also play and listen to
sound, and it knows about Indian ragas and talas.

[Get started](get-started.md){ .md-button .md-button--primary }
[Browse the gallery](gallery/index.md){ .md-button }

## A few pictures

Every picture is made by a short example you can copy and run.

<div class="gallery-grid" markdown>

[![Smooth colour gradients](gallery/images/colour-03_gradients.png){ loading=lazy }](gallery/colour/03_gradients.md)

[![Shapes joined and cut](gallery/images/paths-05_booleans.png){ loading=lazy }](gallery/paths/05_booleans.md)

[![Letters turned into shapes](gallery/images/text-05_text_path.png){ loading=lazy }](gallery/text/05_text_path.md)

[![Little movers pushed by vectors](gallery/images/motion-01_movers.png){ loading=lazy }](gallery/motion/01_movers.md)

</div>

There are more in the [gallery](gallery/index.md) and on the [showcase](gallery/showcase.md) page.

## Your first sketch

```python
import funground as f

f.size(640, 400)
f.background("white")
f.fill("tomato")
f.circle(320, 200, 120)
f.show()
```

Save it as `first.py` and run it. A red circle appears. Change `"tomato"` to `"teal"` and run it
again. That is how you learn: change something small and look at what happens.

## Install

```
python -m pip install git+https://github.com/funground-hq/funground
```

funground is in its first release, 0.1, which is not on PyPI yet. Once it is, `pip install funground` will do.

You need Python 3.11 or newer. The [first chapter of the guide](guide/01_getting_started.md) shows the
steps one by one.

## Where next

- [Get started](get-started.md): install, run your first sketch, and what to read next.
- [Guide](guide/index.md): nineteen short chapters that teach funground step by step.
- [Gallery](gallery/index.md): every example, with its picture, how it works and its code.
- [Reference](reference/Quick_Reference.md): look up a command.
- [Play](play.md): try funground in your browser, without installing. Coming in 0.2.
- [About](about.md): licence, credits and the code.
