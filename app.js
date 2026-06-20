/* app.js - GPS Tachometer PWA Application Logic */

// App State
let speedUnit = localStorage.getItem('speedometer_unit') || 'kmh'; // 'kmh' or 'mph'
let currentState = 'STOPPED'; // 'STOPPED', 'RECORDING', 'PAUSED'
let gpsWatchId = null;
let currentTrip = {
  id: null,
  name: '',
  startTime: null,
  endTime: null,
  points: [], // Array of { lat, lng, speed, timestamp }
  distance: 0, // in km
  maxSpeed: 0, // in km/h
  avgSpeed: 0  // in km/h
};
let lastPosition = null;
let tripTimerInterval = null;
let tripDurationSeconds = 0;
let peakSpeeds = []; // Top 50 peak speeds
let db = null; // IndexedDB reference
let wakeLock = null;

// Leaflet Map variables
let map = null;
let routePolyline = null;
let maxSpeedMarker = null;
let scrubberMarker = null;
let mapPoints = []; // coordinates for Leaflet

// DOM Elements
const speedNumber = document.getElementById('speed-number');
const unitToggle = document.getElementById('unit-toggle');
const statMax = document.getElementById('stat-max');
const statAvg = document.getElementById('stat-avg');
const statDist = document.getElementById('stat-dist');
const statTime = document.getElementById('stat-time');

const btnStart = document.getElementById('btn-start');
const btnPause = document.getElementById('btn-pause');
const btnResume = document.getElementById('btn-resume');
const btnStop = document.getElementById('btn-stop');

const gpsDot = document.getElementById('gps-dot');
const gpsText = document.getElementById('gps-text');
const connDot = document.getElementById('conn-dot');
const connText = document.getElementById('conn-text');
const wakeIcon = document.getElementById('wake-icon');
const wakeText = document.getElementById('wake-text');

// Modal Elements
const saveTripDialog = document.getElementById('save-trip-dialog');
const tripNameInput = document.getElementById('trip-name-input');
const btnDialogSave = document.getElementById('btn-dialog-save');
const btnDialogDiscard = document.getElementById('btn-dialog-discard');

// Navigation Tabs
const navItems = document.querySelectorAll('.nav-item');
const appViews = document.querySelectorAll('.app-view');

// Sub-tabs in History
const tabPeaks = document.getElementById('tab-peaks');
const tabTrips = document.getElementById('tab-trips');
const peaksPanel = document.getElementById('peaks-panel');
const tripsPanel = document.getElementById('trips-panel');
const peaksTableBody = document.getElementById('peaks-table-body');
const tripsListContainer = document.getElementById('trips-list-container');
const btnClearPeaks = document.getElementById('btn-clear-peaks');

// Scrubber
const routeScrubber = document.getElementById('route-scrubber');
const scrubTime = document.getElementById('scrub-time');
const scrubSpeed = document.getElementById('scrub-speed');
const mapRouteMax = document.getElementById('map-route-max');
const mapRouteDist = document.getElementById('map-route-dist');

// Gauge SVG styling parameters
const gaugeFill = document.getElementById('gauge-fill');
const needleGroup = document.getElementById('needle-group');
const GAUGE_MAX_SPEED_KMH = 180;
const GAUGE_MAX_SPEED_MPH = 120;
const GAUGE_DASH_ARRAY = 448; // Circumference of gauge path

/* ----------------------------------------------------
   1. INITIALIZATION & DATABASE SETUP
   ---------------------------------------------------- */

document.addEventListener('DOMContentLoaded', () => {
  initDatabase();
  loadSettings();
  renderGaugeLabels();
  loadPeakSpeeds();
  setupEventListeners();
  updateConnectionStatus();
  initLeafletMap();
  
  // Register Service Worker
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js?v=1.1')
        .then(reg => console.log('ServiceWorker registriert:', reg.scope))
        .catch(err => console.error('ServiceWorker fehlgeschlagen:', err));
    });
  }

  // Monitor network connection status
  window.addEventListener('online', updateConnectionStatus);
  window.addEventListener('offline', updateConnectionStatus);

  // Monitor visibility change for Wake Lock recovery
  document.addEventListener('visibilitychange', handleVisibilityChange);
});

// Initialize IndexedDB for Trips Storage
function initDatabase() {
  const request = indexedDB.open('TachometerDB', 1);

  request.onupgradeneeded = (event) => {
    const database = event.target.result;
    if (!database.objectStoreNames.contains('trips')) {
      database.createObjectStore('trips', { keyPath: 'id' });
    }
  };

  request.onsuccess = (event) => {
    db = event.target.result;
    renderTripsList();
  };

  request.onerror = (event) => {
    console.error('IndexedDB Fehler:', event.target.error);
  };
}

// Load configurations
function loadSettings() {
  unitToggle.textContent = speedUnit;
  document.getElementById('unit-max').textContent = speedUnit;
  document.getElementById('unit-avg').textContent = speedUnit;
}

// Render speedometer gauge speed number markings and ticks
function renderGaugeLabels() {
  const labelsContainer = document.getElementById('gauge-labels');
  const ticksContainer = document.getElementById('gauge-ticks');
  if (!labelsContainer || !ticksContainer) return;
  
  labelsContainer.innerHTML = '';
  ticksContainer.innerHTML = '';

  const maxScaleSpeed = speedUnit === 'kmh' ? GAUGE_MAX_SPEED_KMH : GAUGE_MAX_SPEED_MPH;
  
  // Decide major labels values
  const labels = speedUnit === 'kmh' 
    ? [0, 30, 60, 90, 120, 150, 180] 
    : [0, 20, 40, 60, 80, 100, 120];

  // Draw ticks at every 10 units
  const step = 10;
  for (let val = 0; val <= maxScaleSpeed; val += step) {
    const percentage = val / maxScaleSpeed;
    const angle = -135 + (percentage * 270);
    const rad = (angle - 90) * Math.PI / 180;
    
    // Check if it is a major value (with text label)
    const isMajor = labels.includes(val);
    
    // Major ticks: 89 to 100. Minor ticks: 94 to 100
    const rInner = isMajor ? 89 : 94;
    const rOuter = 100;
    
    const x1 = 150 + rInner * Math.cos(rad);
    const y1 = 150 + rInner * Math.sin(rad);
    const x2 = 150 + rOuter * Math.cos(rad);
    const y2 = 150 + rOuter * Math.sin(rad);
    
    const tickLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    tickLine.setAttribute('x1', x1);
    tickLine.setAttribute('y1', y1);
    tickLine.setAttribute('x2', x2);
    tickLine.setAttribute('y2', y2);
    tickLine.setAttribute('class', isMajor ? 'gauge-tick-major' : 'gauge-tick-minor');
    ticksContainer.appendChild(tickLine);
  }

  // Draw numbers outside the arc (Radius = 126)
  const textRadius = 126;
  labels.forEach(val => {
    const percentage = val / maxScaleSpeed;
    const angle = -135 + (percentage * 270);
    const rad = (angle - 90) * Math.PI / 180;
    
    const x = 150 + textRadius * Math.cos(rad);
    const y = 150 + textRadius * Math.sin(rad);

    const textNode = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    textNode.setAttribute('x', x);
    textNode.setAttribute('y', y + 10); // offset vertical alignment
    textNode.setAttribute('text-anchor', 'middle');
    textNode.setAttribute('class', 'gauge-label-text');
    textNode.textContent = val;
    labelsContainer.appendChild(textNode);
  });
}

// Event handlers setting
function setupEventListeners() {
  // Navigation tabs
  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const viewId = item.getAttribute('data-view');
      switchView(viewId);
    });
  });

  // Sub-tabs in History
  tabPeaks.addEventListener('click', () => {
    tabPeaks.classList.add('active');
    tabTrips.classList.remove('active');
    peaksPanel.classList.add('active');
    tripsPanel.classList.remove('active');
  });

  tabTrips.addEventListener('click', () => {
    tabTrips.classList.add('active');
    tabPeaks.classList.remove('active');
    tripsPanel.classList.add('active');
    peaksPanel.classList.remove('active');
    renderTripsList();
  });

  // Unit toggle
  unitToggle.addEventListener('click', toggleSpeedUnit);

  // Recording controls
  btnStart.addEventListener('click', startRecording);
  btnPause.addEventListener('click', pauseRecording);
  btnResume.addEventListener('click', resumeRecording);
  btnStop.addEventListener('click', stopRecordingConfirmation);

  // Modal controls
  btnDialogSave.addEventListener('click', saveTripToDB);
  btnDialogDiscard.addEventListener('click', discardTripData);

  // Clear unpinned peak speeds
  btnClearPeaks.addEventListener('click', clearUnpinnedPeaks);

  // Scrubber drag event
  routeScrubber.addEventListener('input', handleScrubberChange);
}

// Switch between SPA views
function switchView(viewId) {
  navItems.forEach(item => {
    if (item.getAttribute('data-view') === viewId) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });

  appViews.forEach(view => {
    if (view.id === viewId) {
      view.classList.add('active');
    } else {
      view.classList.remove('active');
    }
  });

  // Re-size Leaflet map dynamically when shown
  if (viewId === 'map-view' && map) {
    setTimeout(() => {
      map.invalidateSize();
      fitMapToRoute();
    }, 100);
  }
}

// Toggle speedometer display speed unit
function toggleSpeedUnit() {
  speedUnit = speedUnit === 'kmh' ? 'mph' : 'kmh';
  localStorage.setItem('speedometer_unit', speedUnit);
  loadSettings();
  renderGaugeLabels();
  updateDashboardDisplay(getCurrentSpeedKmh());
  renderPeaksTable();
  renderTripsList();
}

/* ----------------------------------------------------
   2. GPS TELEMETRY & ROUTE TRACKING
   ---------------------------------------------------- */

// Start Speed and Route Recording
function startRecording() {
  if (currentState !== 'STOPPED') return;

  // Initialize new trip structure
  currentTrip = {
    id: 'trip_' + Date.now(),
    name: '',
    startTime: new Date().toISOString(),
    endTime: null,
    points: [],
    distance: 0,
    maxSpeed: 0,
    avgSpeed: 0
  };

  currentState = 'RECORDING';
  tripDurationSeconds = 0;
  lastPosition = null;
  mapPoints = [];
  
  // Clear map path overlays
  if (routePolyline) {
    routePolyline.setLatLngs([]);
  }
  if (maxSpeedMarker) {
    maxSpeedMarker.remove();
    maxSpeedMarker = null;
  }
  if (scrubberMarker) {
    scrubberMarker.remove();
    scrubberMarker = null;
  }
  routeScrubber.disabled = true;
  routeScrubber.value = 0;

  // Update Buttons
  btnStart.classList.add('hidden');
  btnPause.classList.remove('hidden');
  btnStop.classList.remove('hidden');

  // Request Wake Lock to keep screen on while recording
  requestWakeLock();

  // Reset UI Stats
  statMax.textContent = '0.0';
  statAvg.textContent = '0.0';
  statDist.textContent = '0.00';
  statTime.textContent = '00:00:00';

  // Start Telemetry
  startGpsTracking();

  // Start Timer
  tripTimerInterval = setInterval(updateTripTimer, 1000);
}

// Pause route recording
function pauseRecording() {
  if (currentState !== 'RECORDING') return;

  currentState = 'PAUSED';
  
  btnPause.classList.add('hidden');
  btnResume.classList.remove('hidden');
  
  // Pause Telemetry watch (can save battery)
  stopGpsTracking();
  clearInterval(tripTimerInterval);
  releaseWakeLock();
  
  // Update UI Speed indicator
  updateDashboardDisplay(0);
}

// Resume route recording
function resumeRecording() {
  if (currentState !== 'PAUSED') return;

  currentState = 'RECORDING';
  
  btnResume.classList.add('hidden');
  btnPause.classList.remove('hidden');
  
  requestWakeLock();
  startGpsTracking();
  
  tripTimerInterval = setInterval(updateTripTimer, 1000);
}

// Stop session confirmation
function stopRecordingConfirmation() {
  if (currentState === 'STOPPED') return;

  // Pause tracking immediately
  stopGpsTracking();
  clearInterval(tripTimerInterval);
  releaseWakeLock();

  // Prompt trip name saving
  const formattedDate = new Date(currentTrip.startTime).toLocaleString('de-DE', { 
    weekday: 'short', 
    day: '2-digit', 
    month: '2-digit', 
    hour: '2-digit', 
    minute: '2-digit' 
  });
  tripNameInput.value = `Strecke vom ${formattedDate}`;
  saveTripDialog.classList.remove('hidden');
}

// Complete trip and save to database
function saveTripToDB() {
  currentTrip.endTime = new Date().toISOString();
  currentTrip.name = tripNameInput.value.trim() || 'Unbenannte Strecke';

  // Add trip's max speed to the Peak Speeds Log
  if (currentTrip.maxSpeed > 0) {
    addPeakSpeed(currentTrip.maxSpeed, currentTrip.endTime);
  }

  // Save to IndexedDB
  if (db) {
    const transaction = db.transaction(['trips'], 'readwrite');
    const store = transaction.objectStoreStore ? transaction.objectStore('trips') : transaction.objectStore('trips');
    const request = store.add(currentTrip);

    request.onsuccess = () => {
      console.log('Strecke erfolgreich in IndexedDB gespeichert');
      renderTripsList();
      resetRecordingState();
      saveTripDialog.classList.add('hidden');
      switchView('history-view');
      // Go to trips tab
      tabTrips.click();
    };

    request.onerror = (e) => {
      console.error('Fehler beim Speichern der Strecke:', e.target.error);
      alert('Speichern fehlgeschlagen!');
    };
  } else {
    alert('Datenbankverbindung nicht verfügbar. Strecke verworfen.');
    resetRecordingState();
    saveTripDialog.classList.add('hidden');
  }
}

// Discard recorded data
function discardTripData() {
  if (confirm('Möchtest du diese Aufzeichnung wirklich verwerfen?')) {
    resetRecordingState();
    saveTripDialog.classList.add('hidden');
  }
}

// Reset variables and buttons back to stopped state
function resetRecordingState() {
  currentState = 'STOPPED';
  currentTrip = null;
  lastPosition = null;
  
  btnStart.classList.remove('hidden');
  btnPause.classList.add('hidden');
  btnResume.classList.add('hidden');
  btnStop.classList.add('hidden');
  
  updateDashboardDisplay(0);
}

// Live timer updater
function updateTripTimer() {
  tripDurationSeconds++;
  
  const hours = Math.floor(tripDurationSeconds / 3600);
  const minutes = Math.floor((tripDurationSeconds % 3600) / 60);
  const seconds = tripDurationSeconds % 60;
  
  statTime.textContent = 
    `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

// Start watching device geolocation
function startGpsTracking() {
  if (gpsWatchId !== null) return;

  const geoOptions = {
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: 5000
  };

  gpsWatchId = navigator.geolocation.watchPosition(
    handleGpsUpdate, 
    handleGpsError, 
    geoOptions
  );
}

function stopGpsTracking() {
  if (gpsWatchId !== null) {
    navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = null;
  }
  gpsDot.className = 'status-dot red';
  gpsText.textContent = 'GPS pausiert';
}

// Parse GPS Updates
function handleGpsUpdate(position) {
  const coords = position.coords;
  
  // GPS Signal Accuracy meter
  const accuracy = coords.accuracy;
  updateGpsAccuracyIndicator(accuracy);

  // Speed processing
  let speedKmh = 0;
  if (coords.speed !== null && coords.speed >= 0) {
    // Convert m/s to km/h
    speedKmh = coords.speed * 3.6;
  } else if (lastPosition) {
    // Fallback: calculate speed from coordinate differences if hardware speed sensor is null
    const dist = calculateDistance(
      lastPosition.coords.latitude, 
      lastPosition.coords.longitude, 
      coords.latitude, 
      coords.longitude
    ); // km
    const timeHours = (position.timestamp - lastPosition.timestamp) / 3600000;
    if (timeHours > 0) {
      speedKmh = dist / timeHours;
    }
  }

  // Update live dashboard display speed
  updateDashboardDisplay(speedKmh);

  // If active recording, record point
  if (currentState === 'RECORDING') {
    processTripTelemetryPoint(coords, speedKmh, position.timestamp);
  }

  lastPosition = position;
}

// Process single active route point
function processTripTelemetryPoint(coords, speedKmh, timestamp) {
  const currentPoint = {
    lat: coords.latitude,
    lng: coords.longitude,
    speed: speedKmh,
    timestamp: timestamp
  };

  currentTrip.points.push(currentPoint);
  mapPoints.push([coords.latitude, coords.longitude]);

  // Update total session distance
  if (lastPosition && currentState === 'RECORDING') {
    const stepDistance = calculateDistance(
      lastPosition.coords.latitude,
      lastPosition.coords.longitude,
      coords.latitude,
      coords.longitude
    );
    currentTrip.distance += stepDistance;
    statDist.textContent = currentTrip.distance.toFixed(2);
  }

  // Update session peak speed
  if (speedKmh > currentTrip.maxSpeed) {
    currentTrip.maxSpeed = speedKmh;
    statMax.textContent = convertSpeed(speedKmh).toFixed(1);
  }

  // Update session average speed
  if (currentTrip.points.length > 0) {
    const totalSpeedSum = currentTrip.points.reduce((acc, pt) => acc + pt.speed, 0);
    currentTrip.avgSpeed = totalSpeedSum / currentTrip.points.length;
    statAvg.textContent = convertSpeed(currentTrip.avgSpeed).toFixed(1);
  }

  // Real-time map update
  if (map && routePolyline) {
    routePolyline.addLatLng([coords.latitude, coords.longitude]);
    map.panTo([coords.latitude, coords.longitude]);
  }
}

function handleGpsError(error) {
  console.warn('GPS Fehler:', error.code, error.message);
  gpsDot.className = 'status-dot red';
  gpsText.textContent = 'GPS Signal verloren';
}

// Update top indicator badge based on accuracy (in meters)
function updateGpsAccuracyIndicator(accuracy) {
  if (accuracy <= 10) {
    gpsDot.className = 'status-dot green';
    gpsText.textContent = `GPS bereit (±${Math.round(accuracy)}m)`;
  } else if (accuracy <= 30) {
    gpsDot.className = 'status-dot yellow';
    gpsText.textContent = `GPS schwach (±${Math.round(accuracy)}m)`;
  } else {
    gpsDot.className = 'status-dot red';
    gpsText.textContent = `Ungnaues GPS (±${Math.round(accuracy)}m)`;
  }
}

// Helper to calculate speed based on preference
function convertSpeed(speedKmh) {
  return speedUnit === 'kmh' ? speedKmh : speedKmh * 0.621371;
}

// Get current speedometer display speed (returns Kmh)
function getCurrentSpeedKmh() {
  if (currentState === 'RECORDING' && currentTrip.points.length > 0) {
    return currentTrip.points[currentTrip.points.length - 1].speed;
  }
  return 0.0;
}

// Update SVG Speed Needle and text
function updateDashboardDisplay(speedKmh) {
  const speed = convertSpeed(speedKmh);
  speedNumber.textContent = speed.toFixed(1);

  // Scale calculations for dashboard gauge needle and outline
  const maxScaleSpeed = speedUnit === 'kmh' ? GAUGE_MAX_SPEED_KMH : GAUGE_MAX_SPEED_MPH;
  const speedPercentage = Math.min(speed / maxScaleSpeed, 1.0);

  // Rotation ranges from -135deg (0 kmh) to +135deg (180 kmh)
  const rotationAngle = -135 + (speedPercentage * 270);
  needleGroup.setAttribute('transform', `rotate(${rotationAngle} 150 150)`);

  // Fill circumference arc path
  const fillOffset = GAUGE_DASH_ARRAY * (1.0 - speedPercentage);
  gaugeFill.setAttribute('stroke-dashoffset', fillOffset);
}

/* ----------------------------------------------------
   3. PEAK SPEEDS ENGINE (LOCALSTORAGE TOP 50 LOG)
   ---------------------------------------------------- */

// Load top speeds from storage
function loadPeakSpeeds() {
  const stored = localStorage.getItem('peak_speeds');
  if (stored) {
    peakSpeeds = JSON.parse(stored);
  } else {
    peakSpeeds = [];
  }
  renderPeaksTable();
}

// Add a peak speed to the top 50
function addPeakSpeed(speedKmh, timestampStr) {
  const newRecord = {
    id: 'peak_' + Date.now(),
    speed: speedKmh,
    timestamp: timestampStr,
    pinned: false
  };

  // Add
  peakSpeeds.push(newRecord);

  // Sort descending
  peakSpeeds.sort((a, b) => b.speed - a.speed);

  // Limit to 50 items
  if (peakSpeeds.length > 50) {
    // Find unpinned items starting from the bottom of sorted list (lowest speeds)
    let removed = false;
    for (let i = peakSpeeds.length - 1; i >= 0; i--) {
      if (!peakSpeeds[i].pinned) {
        peakSpeeds.splice(i, 1);
        removed = true;
        break;
      }
    }
    // If all are pinned, we cannot remove anything and we keep more than 50,
    // or let it grow if all are pinned (user instruction: "damit sie nicht überschrieben werden")
  }

  // Save back
  localStorage.setItem('peak_speeds', JSON.stringify(peakSpeeds));
  renderPeaksTable();
}

// Toggle lock status of a record
function togglePinPeakSpeed(id) {
  peakSpeeds = peakSpeeds.map(record => {
    if (record.id === id) {
      return { ...record, pinned: !record.pinned };
    }
    return record;
  });
  localStorage.setItem('peak_speeds', JSON.stringify(peakSpeeds));
  renderPeaksTable();
}

// Delete unpinned peak speeds
function clearUnpinnedPeaks() {
  if (confirm('Möchtest du alle nicht fixierten Höchstgeschwindigkeiten wirklich löschen?')) {
    peakSpeeds = peakSpeeds.filter(record => record.pinned);
    localStorage.setItem('peak_speeds', JSON.stringify(peakSpeeds));
    renderPeaksTable();
  }
}

// Render table view
function renderPeaksTable() {
  peaksTableBody.innerHTML = '';
  
  if (peakSpeeds.length === 0) {
    peaksTableBody.innerHTML = `
      <tr>
        <td colspan="4" class="empty-state">Noch keine Höchstgeschwindigkeiten erfasst.</td>
      </tr>`;
    return;
  }

  peakSpeeds.forEach((record, index) => {
    const tr = document.createElement('tr');
    
    const displaySpeed = convertSpeed(record.speed).toFixed(1);
    const dateObj = new Date(record.timestamp);
    const dateStr = dateObj.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const timeStr = dateObj.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    
    tr.innerHTML = `
      <td><span class="rank-badge">${index + 1}</span></td>
      <td class="speed-cell">${displaySpeed} <span style="font-size: 11px;">${speedUnit}</span></td>
      <td class="time-cell">${dateStr} um ${timeStr}</td>
      <td style="text-align: center;">
        <button class="pin-btn ${record.pinned ? 'pinned' : ''}" onclick="window.parentPinToggle('${record.id}')">
          ${record.pinned ? '&#128274;' : '&#128275;'}
        </button>
      </td>
    `;
    peaksTableBody.appendChild(tr);
  });
}

// Expose lock toggle to global window context for table onclick handler
window.parentPinToggle = function(id) {
  togglePinPeakSpeed(id);
};

/* ----------------------------------------------------
   4. MAP VIEW & ROUTE ANALYZER (SCRUBBER)
   ---------------------------------------------------- */

// Initialize Leaflet Map
function initLeafletMap() {
  // Center default Münich / Germany coordinates
  map = L.map('map', {
    zoomControl: true,
    attributionControl: false
  }).setView([51.165691, 10.451526], 6);

  // Light-mode Map styles using standard OpenStreetMap tiles
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    timeout: 5000
  }).addTo(map);

  // Initialize Route Path Polyline overlay (Blue for contrast against light map)
  routePolyline = L.polyline([], {
    color: '#0066ff',
    weight: 5,
    opacity: 0.8,
    lineJoin: 'round'
  }).addTo(map);
}

// Fit map view frame to contain entire route path coordinates
function fitMapToRoute() {
  if (routePolyline && routePolyline.getLatLngs().length > 0) {
    map.fitBounds(routePolyline.getBounds(), { padding: [20, 20] });
  }
}

// Load trip record onto Map view for scrubbing analysis
function loadTripToMap(trip) {
  if (!map) return;

  // Clear existing
  if (maxSpeedMarker) maxSpeedMarker.remove();
  if (scrubberMarker) scrubberMarker.remove();

  // Draw Route
  const latLngs = trip.points.map(pt => [pt.lat, pt.lng]);
  routePolyline.setLatLngs(latLngs);

  // Identify peak speed point
  let maxPt = null;
  trip.points.forEach(pt => {
    if (!maxPt || pt.speed > maxPt.speed) {
      maxPt = pt;
    }
  });

  if (maxPt) {
    const maxSpeedVal = convertSpeed(maxPt.speed).toFixed(1);
    
    // Custom neon red peak speed marker icon
    const peakIcon = L.divIcon({
      className: 'custom-peak-marker',
      html: `<div style="background-color: #ff0055; border: 2px solid #ffffff; width: 14px; height: 14px; border-radius: 50%; box-shadow: 0 0 10px #ff0055;"></div>`,
      iconSize: [14, 14],
      iconAnchor: [7, 7]
    });

    maxSpeedMarker = L.marker([maxPt.lat, maxPt.lng], { icon: peakIcon })
      .addTo(map)
      .bindPopup(`<strong>Höchstgeschwindigkeit:</strong> ${maxSpeedVal} ${speedUnit}`)
      .openPopup();
  }

  // Setup scrubber slider
  if (trip.points.length > 1) {
    routeScrubber.disabled = false;
    routeScrubber.max = trip.points.length - 1;
    routeScrubber.value = 0;
    
    // Update labels
    mapRouteMax.textContent = `${convertSpeed(trip.maxSpeed).toFixed(1)} ${speedUnit}`;
    mapRouteDist.textContent = `${trip.distance.toFixed(2)} km`;
    
    updateScrubberDetails(trip.points[0]);
  } else {
    routeScrubber.disabled = true;
  }

  // Pan map boundaries to fit coordinates
  setTimeout(() => {
    map.invalidateSize();
    map.fitBounds(routePolyline.getBounds(), { padding: [30, 30] });
  }, 50);
}

// Scrubber slider input handler
function handleScrubberChange(e) {
  const index = parseInt(e.target.value);
  
  // We need to fetch the currently selected trip from context.
  // When showing a saved trip, we cache its points in window context.
  const activeRoute = window.activeScrubbingTrip;
  if (!activeRoute || !activeRoute.points[index]) return;

  const point = activeRoute.points[index];
  updateScrubberDetails(point);
}

// Update map marker positions and scrubber label text values
function updateScrubberDetails(point) {
  const displaySpeed = convertSpeed(point.speed).toFixed(1);
  const timeStr = new Date(point.timestamp).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  scrubTime.textContent = timeStr;
  scrubSpeed.textContent = `${displaySpeed} ${speedUnit}`;

  // Custom scrubbing glider marker
  const scrubIcon = L.divIcon({
    className: 'custom-scrub-marker',
    html: `<div style="background-color: #00f0ff; border: 2px solid #ffffff; width: 16px; height: 16px; border-radius: 50%; box-shadow: 0 0 12px #00f0ff;"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8]
  });

  if (scrubberMarker) {
    scrubberMarker.setLatLng([point.lat, point.lng]);
  } else {
    scrubberMarker = L.marker([point.lat, point.lng], { icon: scrubIcon }).addTo(map);
  }

  map.panTo([point.lat, point.lng]);
}

/* ----------------------------------------------------
   5. TRIPS LIST & DATABASE QUERIES
   ---------------------------------------------------- */

// Fetch and render saved trips list in History View
function renderTripsList() {
  if (!db) return;

  tripsListContainer.innerHTML = '';
  
  const transaction = db.transaction(['trips'], 'readonly');
  const store = transaction.objectStore('trips');
  const request = store.getAll();

  request.onsuccess = (event) => {
    const trips = event.target.result;
    
    // Sort reverse chronological (newest first)
    trips.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));

    if (trips.length === 0) {
      tripsListContainer.innerHTML = '<div class="empty-state">Noch keine Strecken aufgezeichnet.</div>';
      return;
    }

    trips.forEach(trip => {
      const card = document.createElement('div');
      card.className = 'trip-card';
      
      const startTimeObj = new Date(trip.startTime);
      const dateStr = startTimeObj.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
      const timeStr = startTimeObj.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

      // Duration calculations
      const durationMs = new Date(trip.endTime) - startTimeObj;
      const hours = Math.floor(durationMs / 3600000);
      const mins = Math.floor((durationMs % 3600000) / 60000);
      const durationStr = `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')} h`;

      const maxSpeedVal = convertSpeed(trip.maxSpeed).toFixed(1);
      const avgSpeedVal = convertSpeed(trip.avgSpeed).toFixed(1);

      card.innerHTML = `
        <div class="trip-card-header">
          <span class="trip-title">${trip.name}</span>
          <span class="trip-date">${dateStr} um ${timeStr}</span>
        </div>
        <div class="trip-card-stats">
          <div class="trip-card-stat">
            <span class="trip-stat-lbl">Distanz</span>
            <span class="trip-stat-val">${trip.distance.toFixed(2)} km</span>
          </div>
          <div class="trip-card-stat">
            <span class="trip-stat-lbl">Dauer</span>
            <span class="trip-stat-val">${durationStr}</span>
          </div>
          <div class="trip-card-stat">
            <span class="trip-stat-lbl">Max-Speed</span>
            <span class="trip-stat-val">${maxSpeedVal} ${speedUnit}</span>
          </div>
        </div>
        <div class="trip-card-actions">
          <button class="btn btn-outline btn-sm" onclick="window.parentDeleteTrip(event, '${trip.id}')" style="border-color: var(--neon-red); color: var(--neon-red); flex: none;">Löschen</button>
          <button class="btn btn-cyan btn-sm" style="color: #000; flex: none;">Auf Karte zeigen</button>
        </div>
      `;

      // Event to load trip to Map
      card.addEventListener('click', () => {
        window.activeScrubbingTrip = trip;
        loadTripToMap(trip);
        switchView('map-view');
      });

      tripsListContainer.appendChild(card);
    });
  };
}

// Delete a trip
function deleteTrip(id) {
  if (!db) return;
  
  if (confirm('Möchtest du diese Strecke wirklich löschen?')) {
    const transaction = db.transaction(['trips'], 'readwrite');
    const store = transaction.objectStore('trips');
    const request = store.delete(id);

    request.onsuccess = () => {
      console.log(`Strecke ${id} gelöscht.`);
      renderTripsList();
    };
  }
}

// Expose delete to global context for trip-card delete click
window.parentDeleteTrip = function(event, id) {
  event.stopPropagation(); // prevent card selection trigger
  deleteTrip(id);
};

/* ----------------------------------------------------
   6. WAKE LOCK & NETWORK STATUS (BATTERY SAVER)
   ---------------------------------------------------- */

// Keep screen awake while driving
async function requestWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeText.textContent = 'Standby gesperrt';
      document.getElementById('wake-icon').style.color = 'var(--neon-cyan)';
      document.getElementById('wake-icon').style.textShadow = 'var(--shadow-cyan)';
      console.log('Wake Lock aktiv');
    } catch (err) {
      console.warn('Wake Lock fehlgeschlagen:', err.message);
      wakeText.textContent = 'Standby normal';
    }
  } else {
    wakeText.textContent = 'Standby normal';
  }
}

function releaseWakeLock() {
  if (wakeLock !== null) {
    wakeLock.release()
      .then(() => {
        wakeLock = null;
        wakeText.textContent = 'Standby aktiv';
        document.getElementById('wake-icon').style.color = 'var(--text-muted)';
        document.getElementById('wake-icon').style.textShadow = 'none';
        console.log('Wake Lock freigegeben');
      });
  }
}

// Re-acquire Wake Lock when app regains view focus
function handleVisibilityChange() {
  if (document.visibilityState === 'visible' && currentState === 'RECORDING') {
    requestWakeLock();
  }
}

// Connection observer
function updateConnectionStatus() {
  const offlineBadge = document.getElementById('map-offline-badge');
  
  if (navigator.onLine) {
    connDot.className = 'status-dot green';
    connText.textContent = 'Online';
    if (offlineBadge) offlineBadge.classList.add('hidden');
  } else {
    connDot.className = 'status-dot yellow';
    connText.textContent = 'Offline';
    if (offlineBadge) offlineBadge.classList.remove('hidden');
  }
}

/* ----------------------------------------------------
   7. GPS DISTANCE CALCULATIONS (HAVERSINE FORMULA)
   ---------------------------------------------------- */
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in kilometers
  const dLat = degreesToRadians(lat2 - lat1);
  const dLon = degreesToRadians(lon2 - lon1);
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(degreesToRadians(lat1)) * Math.cos(degreesToRadians(lat2)) * 
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c; // in kilometers
  return distance;
}

function degreesToRadians(degrees) {
  return degrees * (Math.PI / 180);
}
