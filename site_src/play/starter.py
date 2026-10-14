import funground as f


def setup():
    f.size(640, 400)


def draw():
    f.background("navy")  # Change "navy" to another colour, such as "plum".
    f.fill("tomato")  # Change "tomato" to "gold", or to a colour you like.
    f.circle(f.mouse_x, f.mouse_y, 80)  # Change 80 to a bigger or a smaller number.


f.run()
