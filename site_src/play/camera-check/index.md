---
title: Camera check
hide:
  - navigation
  - toc
  - footer
---

# Camera check

<div id="camera-check" class="fg-camcheck">
<p>This page shows how your camera and funground work together on this device. It finds out what the camera gives, what a sketch gets from it, and whether the hand model can find a hand.</p>
<ol>
<li>Press <strong>Check the camera</strong>. Allow the camera when the browser asks.</li>
<li>Press <strong>Check the hand model</strong>. Hold one hand up to the camera, with your fingers open, until it finishes. It takes a minute or two the first time. If the page closes or starts again on its own, open it again, press only <strong>Check the camera</strong>, then <strong>Copy all</strong>.</li>
<li>Press <strong>Copy all</strong> and paste the result where you were asked to.</li>
</ol>
<p class="fg-camcheck__buttons">
<button type="button" class="fg-btn fg-btn--small fg-btn--run" id="cc-camera">Check the camera</button>
<button type="button" class="fg-btn fg-btn--small" id="cc-hand">Check the hand model</button>
<button type="button" class="fg-btn fg-btn--small fg-btn--primary" id="cc-copy">Copy all</button>
</p>
<p id="cc-status" class="fg-camcheck__status" role="status">Press a button to begin.</p>
<h2>This device</h2>
<pre id="cc-device" class="fg-camcheck__text"></pre>
<h2>The camera</h2>
<pre id="cc-camera-text" class="fg-camcheck__text">Not checked yet.</pre>
<div class="fg-camcheck__pictures">
<figure><canvas id="cc-own" width="4" height="3"></canvas><figcaption id="cc-own-caption">The camera's own picture</figcaption></figure>
<figure><canvas id="cc-stretch" width="4" height="3"></canvas><figcaption id="cc-stretch-caption">What a sketch gets today (squeezed to fit)</figcaption></figure>
<figure><canvas id="cc-cover" width="4" height="3"></canvas><figcaption id="cc-cover-caption">What a sketch would get if the picture were cut to fit</figcaption></figure>
</div>
<h2>The hand model</h2>
<pre id="cc-hand-text" class="fg-camcheck__text">Not checked yet.</pre>
<div class="fg-camcheck__pictures">
<figure><canvas id="cc-hand-stretch" width="4" height="3"></canvas><figcaption>Squeezed to fit (today). The gold dot is the tip of the index finger.</figcaption></figure>
<figure><canvas id="cc-hand-cover" width="4" height="3"></canvas><figcaption>Cut to fit. The gold dot is the tip of the index finger.</figcaption></figure>
</div>
</div>

<script type="module" src="camera-check.js"></script>
