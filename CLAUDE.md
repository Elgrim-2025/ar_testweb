# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a WebAR (Web-based Augmented Reality) project using the AlvaAR library for camera-based SLAM (Simultaneous Localization and Mapping). The project demonstrates various AR capabilities including:

- Camera-based AR tracking with visual SLAM
- IMU (Inertial Measurement Unit) sensor fusion for enhanced tracking
- Chromakey (green screen) video overlay in AR space
- Touch/mouse controls for AR object manipulation
- Screenshot capture functionality

## Architecture

### Core Components

**AlvaAR Integration** (`assets/alva_ar.js`, `assets/alva_ar_three.js`)
- Main SLAM engine for camera pose estimation
- Bridge between AlvaAR and Three.js coordinate systems
- Provides `findCameraPose()` for visual tracking and `findCameraPoseWithIMU()` for sensor-fused tracking

**View System** (`assets/view.js`)
- `ARCamView`: Primary AR view with chromakey video overlay and touch controls
  - Uses custom chroma key shaders for green screen removal
  - Supports touch gestures: long-press to drag, pinch to scale, mouse wheel to zoom
  - Configurable sensitivity via `MOVE_SENSITIVITY`, `MIN_SCALE`, `MAX_SCALE`, `LONG_PRESS_TIME`
- `ARCamIMUView`: IMU-enhanced view with ground plane interaction
- `ARSimpleView`: Basic AR view for simple demonstrations
- `ARCamMarkerView`: AR view with placement marker system

**Utilities** (`assets/utils.js`)
- `Camera`: Handles getUserMedia camera access with proper error handling
- `Video`: Video file loading and frame extraction
- `onFrame()`: FPS-throttled animation loop (default 30fps)
- `resize2cover()`: Maintains aspect ratio when fitting video to canvas
- Helper functions: `isMobile()`, `isIOS()`, `getScreenOrientation()`

**IMU System** (`assets/imu.js`)
- `IMU`: Device motion and orientation sensor management
- `Quaternion`: Quaternion math for 3D rotations
- Handles permission requests (required on iOS)
- Transforms device orientation to world coordinates with platform-specific adjustments

**Statistics** (`assets/stats.js`)
- Performance monitoring for 'total', 'video', and 'slam' timing

### Application Entry Points

**`index_2.html`** (Latest/Current)
- Camera AR with chromakey video overlay
- Screenshot capture with download functionality
- Event handling: body click resets tracking, capture button takes screenshot

**`index.html`** (IMU-enabled version)
- Camera AR with IMU sensor fusion
- Click to place objects, double-click to reset
- Demonstrates `findCameraPoseWithIMU()` usage

**Other demos:**
- `camera_shot.html`: Camera capture demo
- `test_1.html`, `index_1.html`: Earlier AR experiments
- `video.html`: Video-based AR
- `sandbox/`: Experimental features (GPU, IMU testing)

### Data Flow

1. Camera/video feed → Canvas rendering (`ctx.drawImage()`)
2. Canvas image data → AlvaAR SLAM engine (`alva.findCameraPose()` or `alva.findCameraPoseWithIMU()`)
3. Pose result → Three.js camera transform via `applyPose()`
4. Three.js renders AR scene overlay
5. Stats tracking at each stage

## Development

### Running the Application

Since this is a static web application, you need an HTTP server:

```bash
# Using Python 3
python -m http.server 8000

# Using Node.js http-server (install with: npm install -g http-server)
http-server -p 8000

# Then open http://localhost:8000/index_2.html (or index1.html for IMU version)
```

**Important:** HTTPS is required for:
- Camera access via getUserMedia
- IMU sensors (DeviceMotion/DeviceOrientation)
- Use a local HTTPS server or deploy to HTTPS hosting for full functionality

### Key Patterns

**Camera Initialization:**
```javascript
const config = {
    video: {
        facingMode: 'environment',  // or 'user' for front camera
        aspectRatio: 16 / 9,
        width: { ideal: 1280 }
    },
    audio: false
};
const camera = await Camera.Initialize(config);
```

**AlvaAR Tracking Loop:**
```javascript
const alva = await AlvaAR.Initialize(width, height);
onFrame(() => {
    const frame = ctx.getImageData(0, 0, width, height);
    const pose = alva.findCameraPose(frame);  // or findCameraPoseWithIMU(frame, orientation, motion)
    if (pose) {
        view.updateCameraPose(pose);
    } else {
        view.lostCamera();
    }
}, 30);  // 30 fps
```

**IMU Setup (when needed):**
```javascript
const imu = await IMU.Initialize();
// Use imu.orientation and imu.motion in findCameraPoseWithIMU()
```

### File Organization

- **Root**: HTML entry points for different AR demos
- **assets/**: All JavaScript modules, media files (videos, images), and utilities
- **sandbox/**: Experimental/test files

### Important Implementation Details

1. **Coordinate Systems**: AlvaAR uses a different coordinate system than Three.js. The `AlvaARConnectorTHREE` handles the transformation.

2. **Performance Optimization**:
   - Canvas context uses `desynchronized: true` for better rendering performance
   - Image data context uses `willReadFrequently: true`
   - FPS throttling via `onFrame()` prevents excessive processing

3. **Touch Controls** (`ARCamView`):
   - Long press (300ms) activates drag mode with haptic feedback
   - Two-finger pinch for scaling
   - Mouse fallback for desktop testing
   - Uses raycasting to detect object selection

4. **Chromakey Implementation**:
   - Custom GLSL shaders for real-time green screen removal
   - Adjustable parameters: `keyColor`, `similarity`, `smoothness`, `spill`
   - Falls back to animated test pattern if video fails to load

5. **Screenshot Capture**:
   - Combines multiple canvas layers (camera feed, AR points, 3D view)
   - Uses `stopPropagation()` to prevent triggering other click handlers

## Common Tasks

### Adding a New AR Object

Add to the Three.js scene in your view class:
```javascript
const object = new THREE.Mesh(geometry, material);
this.scene.add(object);
```

### Modifying Chromakey Settings

Adjust uniforms in `ARCamView` constructor (`assets/view.js:68-74`):
```javascript
keyColor: { value: new THREE.Color(0x32A644) },  // Green color to key out
similarity: { value: 0.095 },   // Higher = more aggressive keying
smoothness: { value: 0.082 },   // Edge smoothness
spill: { value: 0.214 }         // Spill suppression
```

### Changing Video Source

In `ARCamView._createVideo()` (`assets/view.js:111`):
```javascript
v.src = './assets/greenscreen.mp4';  // Change to your video path
```

### Adjusting Touch Sensitivity

Modify `ARCamView` instance properties (`assets/view.js:89-92`):
```javascript
this.MOVE_SENSITIVITY = 0.0017;  // Lower = slower movement
this.MIN_SCALE = 0.3;
this.MAX_SCALE = 5.0;
this.LONG_PRESS_TIME = 300;  // milliseconds
```

## Browser Compatibility

- **Camera Access**: Requires getUserMedia support (all modern browsers)
- **IMU Sensors**: iOS requires explicit permission request via `DeviceMotionEvent.requestPermission()`
- **WebGL**: Required for Three.js rendering
- **HTTPS**: Mandatory for camera and sensor access
- **Portrait Mode**: Mobile devices should use portrait orientation (enforced via CSS media queries)
