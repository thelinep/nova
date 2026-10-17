---
id: character-studio
title: Character Studio
section: Create
order: 24.5
summary: Design a character as a 2D puppet, drawn poses or a posable 3D model, put characters together in scenes directed by a local model or imported from a script, give it a voice, sounds and actions, perform it with lip-sync, record clips to the Library, and make AI pictures of the same character.
keywords: scenes scene director prompt to animation local llm ollama script import screenplay srt subtitles captions docx dialogue mira inchi toon studio character sheet drawn poses cutout camera pan zoom fade bonk dust 9:16 portrait reels 1080p render profile scan picture photo drawing image to 3d photo to 3d model triposr mesh statue vision model match look from photo lip sync visemes phonemes kokoro webcam capture motion capture mocap mediapipe face tracking body tracking timeline keyframes animation layers ik inverse kinematics feet reach export gltf glb fbx blender unreal unity body systems anatomy x-ray see inside digestion nutrition circulation transport blood heart respiration breathing lungs excretion kidneys nervous brain skeleton bones hormones endocrine reproduction organs science lesson character studio 3d model three-dimensional pose posing joints face eyes eyebrows mouth ears nose hair body hands fingers legs torso costume kurta dress expressions snapshot puppet design rig animate animation actions moves wave walk jump dance nod bow lip sync lipsync mouth voice sounds sound effects record clip video mp4 portrait turnaround expression sheet sdxl consistent character
views: charstudio
---
**Character Studio** (in the Create group) is where you design a character and bring it to life. A character here is the same one Voice Studio and agents use. If you design a look and actions for an agent's character, that agent still speaks in its own voice.

The screen has three parts: your characters on the left, the **stage** in the middle, and tabs on the right. Above the stage, choose **2D puppet** or **3D model**. A character can have both; the button picks which one is shown, performed and recorded.

## Look

- **Start from** a ready look: Young explorer, Careful thinker, Grandmother, Gardener, Repairer, or Inchi (the learning robot). Then change anything you like.
- **Shape:** body (round, tall, soft, sturdy or robot), head (round, oval, square or a screen face), hair, eyes, mouth, and arms and legs (soft, or robot with coloured joints).
- **Colours:** skin (or shell), outfit, accent, hair, eyes and the stage backdrop.
- **Size:** height and width.
- **Extras:** glasses, antenna, leaf badge, scarf, bindi, mustache, beard, notebook.

The stage shows every change at once. Press **Save** to keep it.

## Voice

Write a line and press **Say it**. The character speaks in its voice, and its mouth follows the sound. To choose the voice itself (a Kokoro blend, a macOS voice or a VoiceStudio profile, with speed, pitch and mood), press **Edit voice in Voice Studio**.

## Sounds

Each character can have up to 40 sounds, such as a laugh, beeps or footsteps.

- **Make a sound:** describe it and press **Make sound**. Stable Audio makes it on this Mac; it needs the sound models from **Setup → Install**.
- **Add from the Library:** pick any audio item.

## Actions

An action is a short performance made of up to 20 steps. Each step has:

- a **move**: stand, talk, wave, nod, shake head, jump, walk, dance, think, celebrate, point, bow, sad or surprised
- how many **seconds** it lasts
- a **line** to say (optional)
- a **sound** to play (optional)

A step lasts as long as its line takes to say, if that is longer than its seconds.

**Play** performs the action on the stage. **Record to Library** performs it and saves it as an MP4 with sound in the Library, ready for the Timeline or Boards. Saving needs ffmpeg.

You can also try any single move from the menu under the stage.

## AI pictures

Character Studio makes pictures of the character with SDXL, using a description built from its look. Add your own words in **Extra words for the pictures**. Choose the kind of picture:

- **Portrait**
- **Full body**
- **Turnaround sheet**: front, side and back
- **Expression sheet**

Every picture uses the character's own seed, so the pictures stay alike. **New variation** tries a different seed. **Use as face** makes a picture the character's face for agents and chat.

AI pictures are close to the puppet, not an exact copy of it. Check them before you use them.

## 3D model

Press **3D model** above the stage. The first time, Maataa starts the 3D model from the 2D puppet's colours. The 3D model has its own tabs:

- **Body:** start from a ready look (Young explorer, Careful thinker, Grandmother, Gardener, Repairer, Learning robot). Then choose the build (slim, average, sturdy, round), hands (mittens or fingers), height, head size, arm and leg length, skin or shell colour and the backdrop. **Robot** gives a shiny shell, coloured joints and glowing eyes.
- **Face:** eyes (shape, colour, size, spacing), eyebrows (shape, colour), mouth (resting shape, width, lip colour), ears (round, small, big, pointed or none, and size), nose, and rosy cheeks. The expression buttons show the face up close.
- **Hair:** short, long, bun, ponytail, braid, curly, spiky or bald, and its colour.
- **Costume:** top (T-shirt, kurta, jacket, dress, long robe, armour), bottom (trousers, shorts, skirt, dhoti or none), shoes (sneakers, boots, sandals, barefoot), their colours, an accent colour, and extras: glasses, cap, scarf, backpack, watch, leaf badge, antenna, bindi, beard, mustache.
- **Pose:** pose every joint.
  - Pick a joint from the list or click a body part on the stage; the selected part glows. Each joint has up to three sliders: bend, twist and tilt.
  - The joints are the whole body, hips, waist, chest, neck and head; both shoulders, elbows, wrists and fingers; and both hips, knees and ankles. **Whole body** also has **Crouch ↔ lift**, for sitting, kneeling and jumping.
  - **Copy to the other side** mirrors an arm or a leg. There are ready poses: relaxed stand, T-pose, wave, cheer, thinking, point, hands on hips, shy, bow, sit, run, kneel and dance.
  - The face has expression buttons (neutral, happy, laughing, sad, cross, surprised, thinking, wink, sleepy) and sliders for each eyebrow, each eye, where the eyes look, the smile and how open the mouth is.
  - **Save pose** keeps a pose with the character. Saved poses appear in Actions as **Pose: name**, so an action can move from pose to pose while the character speaks.

On the stage, drag to turn the camera, scroll to zoom, Shift-drag to move up or down, and double-click to reset. **Front**, **Side**, **Back** and **Face** jump to a view. **Snapshot** saves a PNG of the stage to the Library.

Every move works in 3D too. The mouth follows the voice, the eyes blink, and the character breathes. Record to Library works the same way. AI pictures of a character shown in 3D use a description of the 3D look.

The 3D model is built from simple shapes on this Mac: no model files and nothing downloaded. Clothes are rigid, so a skirt or robe does not bend with the legs, and legs can pass through it in deep poses such as sitting.

## Body systems (3D)

The **Body systems** tab lets you see inside a 3D character. The skin turns see-through and a simplified, labelled model of one system appears, with movement along it:

- **All organs**: the main organs together.
- **Nutrition (digestion)**: food (yellow dots) moves from the mouth through the oesophagus, stomach and small intestine, where nutrients (gold dots) pass into the blood, then through the large intestine to the rectum and anus. The liver, gall bladder and pancreas are shown beside the route; food does not pass through them.
- **Transport (circulation)**: the heart beats; blood moves away from the heart in arteries (red) and back in veins (blue), with a loop through the lungs.
- **Respiration (breathing)**: air moves in and out through the nose, windpipe and bronchi; the lungs swell and the diaphragm moves down as the character breathes in.
- **Excretion (urinary)**: the kidneys filter blood; urine moves down the ureters to the bladder, which slowly fills.
- **Nervous system**: the brain, spinal cord and nerves, with signals moving along them.
- **Skeleton**: skull, backbone, ribs, pelvis and the bones of the arms and legs.
- **Hormones (endocrine)**: pituitary, thyroid, adrenal glands, pancreas and ovaries or testes, with hormones carried round in the blood.
- **Reproduction**: a simplified school-level model of the female or male reproductive organs.

Each system has a short explanation. Labels are in English and Hindi. You can turn labels and movement on or off, change how see-through the skin is and how fast things move, and let the character turn slowly. While a system is shown, the character holds a standing pose; choose **Normal** to see your own pose again.

**Record a 12-second tour** turns the character once while the flows run and saves the clip, with its labels, to the Library. For a narrated lesson, make an action whose steps each choose a body system and say a line. The view changes at each step and the character speaks the explanation.

These are teaching models: shapes, sizes and places are simplified and not to scale.

## Lip-sync

When a character speaks, its mouth makes the shape of each sound (closed for p, b and m; teeth on the lip for f and v; round for o and u; wide for ee), in time with the voice. With Kokoro installed, the sounds come from Kokoro itself, the same phonemes it speaks. Otherwise Maataa works them out from the spelling, which suits Hindi in Devanagari well. The shapes are spread over the parts of the recording that have sound, so the mouth closes in pauses. The status line shows which method was used. This works for the 2D puppet and the 3D model, in actions, the voice tab and the timeline.

## Animate (3D timeline)

The **Animate** tab is a timeline with layers:

- **Body**: poses (the current pose from the Pose tab, or a saved pose). The character blends smoothly from one key to the next.
- **Capture**: webcam captures, which take over the body while they play and blend in and out.
- **Face**: expressions.
- **Layer**: an offset for one joint added on top of everything, for example a head turn over a walk.
- **Voice**: lines, spoken with lip-sync.
- **Sound**: sounds from the character's list.

Click a track to move the playhead, then use the **Add at the playhead** buttons. Click a key to move it to another time or delete it. A pose key you made from the current pose can be edited in the Pose tab. **Keep feet on the ground when crouching (IK)** bends the knees so the feet stay planted when a pose lowers the body. **Hand reach (IK)** in the Pose tab puts a hand at a point (out, up, forward), and the shoulder and elbow follow.

**Record to Library** plays the animation with its voice and sounds and saves an MP4.

## Export to Blender, Unreal and Unity

In Animate, **Export glTF (.glb)** saves the 3D character, with the selected animation baked at 30 frames a second, to **Maataa Library/Exports**. Blender, Unreal, Unity and most 3D tools open .glb. **Export FBX (via Blender)** converts it with Blender, which must be installed (free from blender.org). The model is a hierarchy of shapes moved by its joints, not a skinned mesh. It imports and plays, but it does not bend like a production character rig.

## Capture (webcam)

The **Capture** tab moves the 3D character with your face and body from the webcam, using Google's MediaPipe trackers running in Maataa on this Mac. No video is saved or sent. The tracking models (about 9 MB) are installed once from **Setup → Install → Webcam capture (MediaPipe)**.

- **Face** follows your eyebrows, blinks, gaze, smile, mouth and head turn. **Body** follows your arms, elbows and torso. Turn on **Legs** if you stand back so the camera sees them. **Mirror** makes it move like a mirror image.
- **Record** saves up to 30 seconds as a capture. Play captures here, use them as steps in **Actions** (Capture: name), or place them on the **Animate** timeline.
- Tracking from one camera is approximate: arms crossing the body, turning sideways and hands near the face are the hardest. Good light helps.

## Scan a picture (3D)

The **Scan picture** tab makes a 3D character from a photo or a drawing of one person or character, standing and facing you. Choose a picture from the Library or add one. Everything runs on this Mac.

**1 · Match the posable character.** Press **Scan picture**. Maataa measures colours at the hair, face, top, bottom and shoes, and the picture shows where it looked. With the webcam capture models installed, it also finds the body's joints and measures head size and arm and leg length. If a vision model is installed in Models (for example qwen2.5vl or llama3.2-vision), Maataa asks it about the hair style, clothes and extras such as glasses. Otherwise those are guessed from the colours. The stage shows the result. Press **Keep this look** to use it, then **Save**, or **Back to my character** to drop it. Poses, captures and animations are kept.

The match is a cartoon version made from the 3D model's own parts, not a likeness. Patterns, logos and exact hairstyles are not copied. Check it and adjust it in Body, Face, Hair and Costume.

**2 · Make a 3D mesh.** **Make 3D mesh** uses TripoSR (free, MIT licence) to build a coloured 3D shape of the picture. It also guesses the side and back, which the picture does not show. Install it once from **Setup → Install → Picture to 3D mesh (TripoSR)** (about 4 GB). A mesh takes from under a minute to several minutes, depending on the Mac and the detail. Only one image, video or mesh job runs at a time.

The mesh is a statue: it has no joints, so it cannot be posed, animated or lip-synced. Show it on its own or **Beside** the posable character to compare, or save it as **.glb** (or **.fbx** through Blender) to Maataa Library/Exports. **Remove the background first** works best for photos. Turn it off for a drawing that is already on a plain background.

## Scenes

Press **Scenes** at the top of Character Studio. A scene puts up to four characters on one backdrop for 3–30 seconds. **Characters** takes you back to designing them.

- **Add Mira & Inchi demo** adds two ready characters with drawn poses (Mira: run, tap, stop; Inchi: run, flinch, scared), the courtyard backdrop and a 16-second chase scene. The drawings come from the Mira–Inchi project. They speak with Kokoro Hindi voices.
- **The stage and timeline.** Press **Play**, or drag the playhead. The timeline shows the beats, the lines and the camera shots; click one to jump to it.
- **Direct.** Describe what happens in Hindi or English and press **Direct the scene**. A local model from Models (for example qwen3:8b) writes the beats, lines and camera for this cast, using only the poses each character has. It plans movement; it does not draw new pictures. If its answer is not usable, your scene stays as it was. Anything it got wrong is fixed and listed (for example a pose a character does not have).
- **Cast.** Choose up to four characters, their size and ground line. A character appears if it has a 2D puppet or drawn poses. **Voice only** speaks off-screen with captions.
- **Beats.** In each beat an actor moves from one x to another in one pose, facing left or right. Runners bounce. **Split at playhead** cuts a beat in two; effects are **bonk** (a comic hit), **dust** (behind runners) and **sparkle**.
- **Lines.** Each line is spoken in the character's voice and shown as a caption. **Time lines to their voices** makes each line as long as its voice takes, so endings are not cut off.
- **Camera.** Without shots the whole stage shows. Shots pan and zoom (up to 3.5×) and start with a cut or a fade from black. **Frame an actor** zooms in on one.
- **Backdrop.** A colour, the courtyard, or any picture from the Library.
- **Script.** Import TXT, MD, DOCX or SRT, or paste a script. Dialogue is written as **Name: line**; other lines are kept as notes on the first scene. Long scripts become several scenes of up to 30 seconds. Speakers whose names match a character become that character (add other names, such as मीरा=Mira); the rest speak off-screen. Text timing is estimated at 2.4 words a second, so check it; SRT keeps its timing.
- **Render.** Choose 720p or 1080p, 24 or 30 frames a second, 16:9 or 9:16 portrait (the whole stage with bars above and below, captions in the lower bar), captions on or off, and quality. **Before recording** lists problems such as two lines at once. **Record to Library** plays the scene in real time and saves an MP4 with sound. **Download SRT** saves the lines as subtitles.

A scene is limited animation: drawings and puppets moving across a backdrop, not film-quality character animation. Drawn characters do not move their mouths.

## Drawn poses

The **Drawn poses** tab (2D) gives a character pictures to use in scenes. Import a character sheet from the Library or a file, set its columns and rows, click the cells you want and name each one (run, tap, scared…). Two cells with the same name become one moving pose. Each cell should hold one whole figure facing right; a transparent background works best (on an opaque sheet the margins are trimmed by the corner colour, but the background stays). Press **Save** to keep them.
