---
title: Play
hide:
  - navigation
  - toc
  - footer
---

# Play

<div class="fg-play-help" markdown>

**Write a sketch, press Run, and see it**, with nothing to install. Pick an example from the list, or start with a
blank sketch. With **Auto-run** on, the sketch runs again a moment after you stop typing.

<ul>
<li class="fg-keys-only"><strong>Keys:</strong> <kbd>Ctrl</kbd> + <kbd>Enter</kbd> runs, <kbd>Esc</kbd> stops,
<kbd>Ctrl</kbd> + <kbd>S</kbd> shares. Click the picture to give it the mouse and keys.</li>
<li class="fg-keys-only"><strong>Numbers:</strong> put the cursor on a number and press <kbd>Alt</kbd> +
<kbd>↑</kbd> or <kbd>↓</kbd> to change it. Add <kbd>Shift</kbd> for bigger steps. Or hold <kbd>Alt</kbd> and drag it.</li>
<li><strong>Share</strong> copies a link that holds your code. Anyone who opens it sees your code and can run it.</li>
<li><strong>Reset</strong> goes back to the original. Unsaved changes stay in this browser only.</li>
<li><strong>Messages:</strong> the line in the bar at the top tells you what Play is doing, what it just did, and what went wrong in your sketch. A note goes after a few seconds. An error stays until the next Run. The small button with a number opens everything Play said in this visit. What your sketch prints stays in Output.</li>
<li><strong>Course lessons:</strong> an example from the course shows what to predict and compare. After Compare, <strong>Extend</strong> opens the same experiment written with funground's studio tools. <strong>Keep this</strong> copies your sketch, with your note, into My sketches. If the sketch is running, it also keeps its picture, a copy of the code and a record in My files (they are called studio/001.png, studio/001.py and studio/001.json).</li>
<li><strong>My files:</strong> keep what a sketch saves, or add your own, and every sketch can open them by name. They stay in this browser only.</li>
<li><strong>More than one file:</strong> open <strong>File</strong> and choose <strong>New file</strong> to add a file such as helpers.py to your sketch. Then write <code>import helpers</code> in your main file. Run always starts the main file. Download saves a sketch with several files as a .zip, and Share puts every file in the link.</li>
<li class="fg-keys-only">Drag the bar between the code and the picture to give either one more room.</li>
<li>If the camera does not work well on your device, the <a href="camera-check/">camera check</a> shows why.</li>
<li>If your camera can change its focus, a Focus control appears under the picture while the camera is on: Auto, or a slider from near to far. A phone's front camera does not get one, because it cannot change its focus.</li>
<li>If the camera's picture has another shape than the size your sketch asked for, funground cuts evenly from the long sides, so faces keep their shape.</li>
<li>Your sketches run in a separate, sandboxed website (funground-run.github.io), so a sketch can never reach
this site. To keep sketches on GitHub, use the <a href="https://github.com/funground-hq/sketchbook">sketchbook</a> and the
funground extension in github.dev.</li>
</ul>

Made for Chrome; Edge, Firefox and Safari are not tested yet. Python, funground and its drawing library load into
your browser, about 12 MB the first time and then from its cache.

</div>

<div id="funground-play" class="play">
  <noscript>The Play page needs JavaScript to run Python in your browser.</noscript>
</div>

<script>
  /* Embed mode (S-240): the class goes on at once, so the site's header never flashes in a frame. play.js reads the same address. */
  if (new URLSearchParams(location.search).get("embed") === "1") document.documentElement.classList.add("fg-embed");
</script>
<script type="module" src="play.js"></script>
