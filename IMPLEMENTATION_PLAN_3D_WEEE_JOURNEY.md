# DR.WEEE 3D WEEE Journey

## Goal

Replace the generic futuristic hero treatment with a branded, scroll-driven story:

`Home -> DR.WEEE facility -> Phone exploded view -> Motherboard selection -> Secure data destruction -> Material recovery -> Circular reuse`

The experience should feel industrial, intelligent, and human. The 3D layer should explain what DR.WEEE does, while normal HTML remains responsible for content, accessibility, SEO, translation, and calls to action.

## Recommended Tools and Websites

### Production-quality 3D

- [Blender](https://www.blender.org/) - Create and optimize the phone, motherboard, material pieces, and facility components. Export as `.glb` or `.gltf`.
- [Sketchfab](https://sketchfab.com/) - Source a phone or electronics reference model when a custom model is not available. Check the license before using an asset commercially.
- [Poly Haven](https://polyhaven.com/) - Free HDRIs, textures, and materials for rendering and reference.
- [ambientCG](https://ambientcg.com/) - Free physically based materials such as brushed metal, plastic, glass, and concrete.

### Web 3D and motion

- [Three.js](https://threejs.org/) - Recommended runtime because this project is a vanilla HTML/CSS/JavaScript site.
- [GSAP](https://gsap.com/) - Use ScrollTrigger for reliable scroll-driven sequencing and timeline control.
- [glTF Transform](https://gltf-transform.dev/) - Compress, inspect, and optimize exported `.glb` assets.
- [Draco](https://google.github.io/draco/) - Geometry compression for smaller models.
- [KTX-Software](https://github.com/KhronosGroup/KTX-Software) - Compress textures for faster loading when texture-heavy assets are introduced.

### Prototyping options

- [Spline](https://spline.design/) - Useful for quickly testing the composition and interaction idea. Use it for prototyping or a small embedded scene, not as the final solution if performance and full control are priorities.
- [Rive](https://rive.app/) - Good for the DR.WEEE character, interface states, and lightweight 2D animations around the 3D scene.
- [LottieFiles](https://lottiefiles.com/) - Use only for small decorative process icons or loading states.

### Recommended final stack

Use Blender for assets, Three.js for rendering, GSAP ScrollTrigger for the timeline, and Rive only if the doctor character needs animation. Do not make the entire site dependent on an iframe or a third-party scene editor.

## Current Files to Change

### `index.html`

1. Replace the external futuristic city video in `.hero__background`.
2. Add a new `#weee-journey` section after the hero or use the hero as the first stage of the journey.
3. Add a semantic HTML content rail beside the canvas:
   - Collection
   - Arrival at DR.WEEE
   - Device separation
   - Motherboard and data security
   - Material recovery
   - Circular reuse
4. Add a visible static poster image inside the 3D wrapper for loading and unsupported-device fallback.
5. Keep all headings, descriptions, statistics, and buttons as real HTML with `data-i18n` attributes.
6. Add a `noscript` fallback explaining the recycling process with the existing facility and process images.
7. Add `aria-live="polite"` to the active process label so the current stage can be announced without making the canvas itself the only source of meaning.

### `package.json`

Add runtime dependencies:

```json
"three": "^0.179.0",
"gsap": "^3.13.0"
```

If the project continues to use CDN scripts instead of npm modules, use pinned versions and Subresource Integrity where available. The npm approach is preferred because it gives the scene a controlled, repeatable dependency version.

### `js/main.js`

1. Keep the existing application initialization intact.
2. Add a call to `initWeeeJourney()` after the existing animation setup.
3. Do not start WebGL on pages that do not contain `#weee-journey`.
4. Do not start the render loop until the scene is near the viewport.
5. Remove or disable the generic hero particle canvas when the new journey is active. Avoid running two animation systems over the same hero.

### New file: `js/weee-journey.js`

Create a self-contained module with these responsibilities:

- Create the Three.js scene, camera, renderer, lights, and controls.
- Load the `.glb` models with `GLTFLoader`.
- Load a compressed model with `DRACOLoader` when Draco compression is used.
- Respect device pixel ratio with a capped value of `1.5`.
- Resize the renderer through `ResizeObserver`.
- Pause rendering when the section is outside the viewport using `IntersectionObserver`.
- Expose a small API for the scroll timeline:
  - `setJourneyProgress(progress)`
  - `setActiveStage(stage)`
  - `destroyJourney()`
- Respect `prefers-reduced-motion` by displaying stable stages with minimal transitions.
- Fall back to the poster image if WebGL is unavailable or model loading fails.
- Never place essential text only inside the canvas.

### New file: `js/weee-journey-timeline.js`

Use GSAP ScrollTrigger to map scroll progress to the scene:

```text
0.00 - 0.12  Phone is placed in a home collection box
0.12 - 0.24  Phone travels toward the DR.WEEE facility
0.24 - 0.45  Phone opens into a precise exploded view
0.45 - 0.58  Camera moves toward the motherboard
0.58 - 0.70  A hand selects and lifts the motherboard
0.70 - 0.84  Data destruction and component sorting
0.84 - 1.00  Materials reassemble into a circular reuse visual
```

The timeline should update the active HTML stage and not rely on hover, since the primary interaction is scrolling and mobile users may not have a pointer.

### New file: `css/weee-journey.css`

Add styles for:

- A sticky or pinned journey viewport.
- A responsive canvas with stable dimensions.
- Text stages that fade and move subtly as the active stage changes.
- A progress rail using the DR.WEEE teal and lime colors.
- A visible fallback poster.
- Loading status and error status.
- Mobile layout where the canvas appears above the stage text.
- High-contrast focus styles for any stage controls.
- `prefers-reduced-motion` rules.

Avoid putting the canvas inside a rounded card. It should feel like an open product demonstration, not a dashboard widget.

### New directory: `models/weee-journey/`

Add optimized assets:

```text
phone-shell.glb
phone-components.glb
motherboard.glb
recycling-materials.glb
hand-motherboard.glb
facility-line.glb
```

Use one combined model first if separate assets create loading overhead. Split the assets only when individual stages need independent animation or interaction.

### New directory: `images/3d/`

Add static fallbacks and social previews:

```text
weee-journey-poster.webp
phone-exploded-poster.webp
motherboard-recovery-poster.webp
weee-journey-og.webp
```

Generate these from the same Blender scene so the fallback and 3D scene share the same art direction.

### `css/main.css`

1. Add design tokens for the new material palette:
   - Graphite
   - Deep green
   - Teal
   - Lime
   - Copper
   - Recovered gold
2. Reduce dependence on generic glassmorphism in the hero.
3. Update the hero background so the 3D scene has clear contrast behind the DR.WEEE wordmark.
4. Keep the existing Poppins and DM Serif pairing initially, but use the serif face sparingly around the 3D story so the scene remains technical and precise.
5. Add a loading background color that matches the poster image.

### `css/components.css`

1. Reduce the number of uniform floating cards in the services and ventures sections.
2. Add a larger visual treatment for the three service pathways:
   - Recover
   - Renew
   - Scale
3. Use image crops and small motion details instead of applying the same hover lift to every card.
4. Keep cards for repeated content, but do not place cards inside the 3D journey section.

### `css/rtl.css`

1. Ensure the stage text rail reverses correctly for Arabic.
2. Keep the canvas camera composition unchanged unless the scene has directional labels.
3. Mirror arrows and progress indicators where appropriate.
4. Test Arabic text lengths inside every stage.

### `locales/en.json`, `locales/ar.json`, `locales/it.json`

Add translations for:

```text
journey.label
journey.title
journey.description
journey.stage.collection
journey.stage.arrival
journey.stage.separation
journey.stage.dataSecurity
journey.stage.recovery
journey.stage.reuse
journey.status.loading
journey.status.fallback
journey.cta
```

Keep the language focused on verified operations. Do not claim a material is recovered unless DR.WEEE actually performs that recovery step.

## 3D Art Direction

### Phone model

Use a recognizable but generic smartphone. Do not copy a specific manufacturer design or logo. The model should have enough detail to communicate:

- Screen and glass
- Battery
- Camera module
- Motherboard
- Aluminum or plastic frame
- Screws and connectors
- Circuit traces

### Materials

Use restrained realism:

- Graphite and dark plastic for the device body
- Translucent glass for the screen
- Copper for recovered metal pathways
- Warm gold only for small contact details
- Teal and lime for process guides and active states
- Neutral gray for industrial machinery

### Hand interaction

The hand should be realistic, calm, and purposeful. It should lift the motherboard only after the exploded view is fully formed. Avoid exaggerated gestures, distorted fingers, or a mascot-like hand.

### DR.WEEE character

Use the existing doctor logo as a small guide, badge, or animated 2D companion. Do not make it the main 3D subject. The phone, motherboard, and recovery process should remain the focus.

## Performance Requirements

- Target less than 2 MB for the initial scene payload on a good mobile connection.
- Load the main model only when the journey is near the viewport.
- Use `.glb` rather than uncompressed OBJ or FBX in production.
- Compress geometry with Draco or Meshopt.
- Compress textures and avoid large 4K textures unless they are genuinely visible.
- Cap renderer pixel ratio at `1.5`.
- Pause the animation when the section is not visible.
- Reduce geometry, shadows, and post-processing on mobile.
- Avoid a continuously running particle system unless it adds meaning to the process.
- Keep the static poster visible until the first frame is ready.

## Accessibility Requirements

- Every process stage must exist as readable HTML.
- The canvas must have a meaningful accessible label such as `DR.WEEE phone recycling journey`.
- Provide a reduced-motion mode.
- Provide a pause or static-view option if the animation is long or highly active.
- Ensure keyboard users can move between stage controls.
- Do not encode translations or essential statistics inside the model textures.
- Keep all primary CTAs as normal links.

## Implementation Phases

### Phase 1: Art direction prototype

- Create the phone exploded-view composition in Blender or Spline.
- Test the color system against the DR.WEEE logo.
- Render the static poster and mobile poster.
- Confirm the visual story with the real company process before coding.

### Phase 2: Static website integration

- Add the journey section markup to `index.html`.
- Add the poster fallback.
- Add the translated stage content.
- Add responsive CSS.
- Confirm the homepage still works with JavaScript disabled.

### Phase 3: Three.js scene

- Add Three.js and the model loader.
- Load the phone model.
- Add camera, lighting, and basic materials.
- Add stage-based model transforms.
- Add WebGL fallback and loading states.

### Phase 4: Scroll choreography

- Add GSAP ScrollTrigger.
- Pin the journey viewport only on desktop-sized screens.
- Use a natural stacked layout on mobile.
- Synchronize the active stage text with the camera and model progress.

### Phase 5: Motherboard and recovery sequence

- Add the hand and motherboard assets.
- Animate the motherboard selection.
- Show data destruction as a clear, non-destructive visual process.
- Show material paths for copper, glass, plastic, and other verified outputs.
- End with a circular reuse state and a link to the services or impact page.

### Phase 6: Quality and launch

- Test Chrome, Safari, Firefox, and mobile browsers.
- Test English, Arabic, and Italian.
- Test WebGL disabled, slow network, reduced motion, and JavaScript disabled.
- Run Lighthouse on mobile.
- Confirm no console errors and no layout shift while the scene loads.
- Confirm analytics events for stage views, CTA clicks, fallback usage, and reduced-motion usage.

## Analytics Events

Add events through the existing analytics layer:

```text
weee_journey_view
weee_journey_stage_view
weee_journey_cta_click
weee_journey_fallback_view
weee_journey_reduced_motion
```

Do not record sensitive user data. Only record the stage name and general interaction event.

## Acceptance Criteria

The implementation is complete when:

- The hero no longer depends on the generic external city video.
- The phone journey is understandable without reading the canvas.
- Scrolling progresses through the phone separation and motherboard sequence.
- The scene has a static fallback before and instead of WebGL.
- The page remains usable on mobile.
- Reduced motion removes or minimizes continuous animation.
- Arabic and Italian layouts remain readable.
- The 3D assets are optimized and lazy-loaded.
- The Impact section contains real, verified data rather than placeholder cards.
- The visual result is clearly DR.WEEE: e-waste, recovery, the doctor character, Cairo/Egypt, and measurable impact are all present.
