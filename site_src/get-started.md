# Get started

You need three things: Python 3.11 or newer, a terminal, and a few minutes.

## 1. Install

In a terminal, in the folder where you keep your sketches:

```
python -m venv .venv
.venv\Scripts\activate        # Windows;  on macOS or Linux:  source .venv/bin/activate
python -m pip install git+https://github.com/funground-hq/funground
```

funground 0.1 is not on PyPI yet. Once it is, `python -m pip install funground` will do.

On Linux, install the Cairo library first. On Debian or Ubuntu that is
`sudo apt install libcairo2-dev pkg-config python3-dev`.

## 2. Run a sketch

Save this as `first.py` and run it with `python first.py`:

```python
import funground as f


def setup():
    f.size(640, 400)


def draw():
    f.background("white")
    f.fill("tomato")
    f.circle(f.mouse_x, f.mouse_y, 80)


f.run()
```

A window opens. The circle follows your mouse. Press **Escape** to stop.

`setup()` runs once. `draw()` runs again and again, about sixty times a second. That is all a
moving picture is: the same drawing, repeated, a little different each time.

## 3. Keep going

- Read the [guide](guide/index.md) in order. Each chapter ends with a few small exercises.
- Open the [gallery](gallery/index.md), pick a picture you like, and read how it works. Copy its code
  and change it.
- When you are stuck, see [When something goes wrong](guide/errors.md) and the
  [glossary](guide/glossary.md).
- Coming from p5.js or Processing? Read [chapter 14](guide/14_coming_from_p5_processing.md).
  Coming from DrawBot? Read [chapter 15](guide/15_coming_from_drawbot.md).
