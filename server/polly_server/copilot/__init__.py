"""The copilot in the notch: it watches what the user is doing and offers help.

The desktop app's native helper reads the screen (accessibility text, Apple
Vision OCR, a screenshot of the focused window) and posts snapshots here. From
each snapshot the copilot:

1. glances at the screenshot with the vision model (`vision.py`), cached per
   window image, so the brain knows what the window shows;
2. asks the brain, Nemotron, whether to offer anything: action chips for the
   app in front, a hint (a reply draft, a formula), to-dos it spotted
   (`brain.py`);
3. streams the hint, and runs the chip actions and questions the user asks
   (`actions.py`), with the vision model as a tool for when text is not enough;
4. keeps a searchable text history of what was on screen (`recall.py`).

Nothing is read unless the user turned the copilot on (⌃⌥P), and the helper
drops excluded apps, sites and windows before anything reaches the server.
"""
