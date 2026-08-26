'use strict';

/**
 * Live Concert Industry Ontology — INDUSTRY STANDARD seed.
 *
 * This file is the developer-maintained baseline of the domain model.
 * Everything here is tier='industry_standard'. It is intentionally conservative:
 * we describe roles, workflows, documents, and terminology in *general*
 * terms, and we flag variability explicitly rather than pretending there is
 * one true value. Venue policy, show-specific facts, historical observations,
 * and user-instructed rules override this seed at query time.
 *
 * Precedence (highest first) — enforced by industryKnowledge.js:
 *
 *   show_specific  >  user_instructed  >  venue_policy  >
 *   historical_observation  >  industry_standard  >  unknown
 *
 * Do not invent specifics. If the industry has no single answer, populate
 * `variability` and leave `defaultValue` unset.
 */

// ── Domains ─────────────────────────────────────────────────────────────────

const DOMAINS = {
  show_advancement:      { id: 'show_advancement',      label: 'Show Advancement' },
  production:            { id: 'production',            label: 'Production' },
  tour_management:       { id: 'tour_management',       label: 'Tour Management' },
  production_management: { id: 'production_management', label: 'Production Management' },
  venue_management:      { id: 'venue_management',      label: 'Venue Management' },
  promoters:             { id: 'promoters',             label: 'Promoters' },
  booking:               { id: 'booking',               label: 'Booking' },
  agencies:              { id: 'agencies',              label: 'Agencies' },
  artist_management:     { id: 'artist_management',     label: 'Artist Management' },
  technical_production:  { id: 'technical_production',  label: 'Technical Production' },
  audio:                 { id: 'audio',                 label: 'Audio' },
  lighting:              { id: 'lighting',              label: 'Lighting' },
  video:                 { id: 'video',                 label: 'Video' },
  rigging:               { id: 'rigging',               label: 'Rigging' },
  stage_management:      { id: 'stage_management',      label: 'Stage Management' },
  backline:              { id: 'backline',              label: 'Backline' },
  rf:                    { id: 'rf',                    label: 'RF Coordination' },
  power:                 { id: 'power',                 label: 'Power / Electrical' },
  labor:                 { id: 'labor',                 label: 'Labor' },
  stagehands:            { id: 'stagehands',            label: 'Stagehands', parent: 'labor' },
  security:              { id: 'security',              label: 'Security' },
  hospitality:           { id: 'hospitality',           label: 'Hospitality' },
  catering:              { id: 'catering',              label: 'Catering', parent: 'hospitality' },
  transportation:        { id: 'transportation',        label: 'Transportation' },
  trucking:              { id: 'trucking',              label: 'Trucking',   parent: 'transportation' },
  buses:                 { id: 'buses',                 label: 'Tour Buses', parent: 'transportation' },
  parking:               { id: 'parking',               label: 'Parking' },
  credentials:           { id: 'credentials',           label: 'Credentials' },
  dressing_rooms:        { id: 'dressing_rooms',        label: 'Dressing Rooms', parent: 'hospitality' },
  production_offices:    { id: 'production_offices',    label: 'Production Offices' },
  schedule:              { id: 'schedule',              label: 'Show Schedule' },
  settlement:            { id: 'settlement',            label: 'Settlement' },
  safety:                { id: 'safety',                label: 'Safety' },
  fire_life_safety:      { id: 'fire_life_safety',      label: 'Fire / Life Safety', parent: 'safety' },
  venue_operations:      { id: 'venue_operations',      label: 'Venue Operations' },
  documents:             { id: 'documents',             label: 'Documents' },
  vendor_coordination:   { id: 'vendor_coordination',   label: 'Vendor Coordination' },
};

// ── Concepts ────────────────────────────────────────────────────────────────
// Each concept: { id, label, domain, kind, description, synonyms[], relatedTo[],
//                 responsibilities[]?, variability[]?, requiredBy[]? }
//
// `kind` is one of: role | phase | document | equipment | metric | facility | policy | event
//
// `synonyms` are strings. If a synonym is AMBIGUOUS in the wild (e.g. "PM"),
// keep it OUT of the synonym list and register it in AMBIGUOUS_TERMS instead.

const CONCEPTS = [
  // ── Roles: Tour side ─────────────────────────────────────────────────────
  {
    id: 'tour_manager', label: 'Tour Manager', domain: 'tour_management', kind: 'role',
    description: 'The artist-facing operations lead traveling with the tour. Owns artist logistics, day-sheet, and settlement on the road.',
    synonyms: ['Tour Manager', 'Touring Manager'],
    responsibilities: ['artist logistics', 'day sheet', 'settlement on the road', 'tour finances', 'guest list', 'ground transport'],
    relatedTo: ['tour_production_manager', 'artist_manager', 'production_manager_venue'],
  },
  {
    id: 'tour_production_manager', label: 'Tour Production Manager', domain: 'tour_management', kind: 'role',
    description: 'The touring party\'s technical/production lead. Advances the show with the venue PM. On smaller tours the TM and TPM are the same person.',
    synonyms: ['Tour Production Manager', 'Touring Production Manager', 'Tour PM'],
    responsibilities: ['technical advance', 'rider enforcement', 'crew management', 'schedule ownership on tour side'],
    relatedTo: ['tour_manager', 'production_manager_venue', 'stage_manager'],
  },
  {
    id: 'artist_manager', label: 'Artist Manager', domain: 'artist_management', kind: 'role',
    description: 'Long-term career representative for the artist. Rarely involved in day-to-day advance but is the escalation path for artist-related issues.',
    synonyms: ['Manager', 'Artist Management'],
    relatedTo: ['tour_manager', 'booking_agent'],
  },
  {
    id: 'booking_agent', label: 'Booking Agent', domain: 'agencies', kind: 'role',
    description: 'Sells and structures the show at the agency. Owns the deal memo; usually hands the show off to the promoter and tour once confirmed.',
    synonyms: ['Agent', 'Responsible Agent'],
    relatedTo: ['agency', 'promoter', 'artist_manager'],
  },
  {
    id: 'foh_engineer', label: 'FOH Engineer', domain: 'audio', kind: 'role',
    description: 'Front-of-house audio engineer. Mixes the show for the audience.',
    synonyms: ['FOH', 'Front of House Engineer', 'House Engineer (tour)', 'A1'],
    relatedTo: ['monitor_engineer', 'systems_tech'],
  },
  {
    id: 'monitor_engineer', label: 'Monitor Engineer', domain: 'audio', kind: 'role',
    description: 'Mixes on-stage monitors / in-ear mixes for the performers.',
    synonyms: ['Monitors', 'MON', 'A2 (in some markets)'],
    relatedTo: ['foh_engineer', 'iem'],
  },
  {
    id: 'systems_tech', label: 'Systems Tech', domain: 'audio', kind: 'role',
    description: 'Tunes and maintains the PA system; typically the house or vendor systems engineer.',
    synonyms: ['Systems Engineer', 'PA Tech'],
    relatedTo: ['foh_engineer', 'pa_system'],
  },
  {
    id: 'lighting_designer', label: 'Lighting Designer', domain: 'lighting', kind: 'role',
    description: 'Designs and often operates lighting looks/cues for the show.',
    synonyms: ['LD', 'Lighting Director'],
    relatedTo: ['lighting_console', 'lighting_plot'],
  },
  {
    id: 'video_engineer', label: 'Video Engineer', domain: 'video', kind: 'role',
    description: 'Runs the video system: IMAG cameras, LED walls, playback.',
    synonyms: ['V1', 'Video Director', 'Screens Engineer'],
    relatedTo: ['led_wall', 'imag'],
  },
  {
    id: 'rf_coordinator', label: 'RF Coordinator', domain: 'rf', kind: 'role',
    description: 'Coordinates wireless microphone, IEM, and comms frequencies to prevent interference and comply with local spectrum rules.',
    synonyms: ['RF Tech', 'Frequency Coordinator'],
    relatedTo: ['wireless_channels', 'iem'],
  },

  // ── Roles: Venue side ────────────────────────────────────────────────────
  {
    id: 'production_manager_venue', label: 'Production Manager (Venue)', domain: 'production_management', kind: 'role',
    description: 'The venue\'s counterpart to the tour PM. Owns the advance from the venue side, staffs local labor, and enforces venue policy.',
    synonyms: ['Venue Production Manager', 'House Production Manager', 'Venue PM'],
    responsibilities: ['run advance from venue side', 'staff labor calls', 'enforce venue policy', 'own building schedule', 'sign off on rig plot', 'coordinate settlement with tour and promoter'],
    relatedTo: ['tour_production_manager', 'venue_manager', 'stage_manager_venue'],
  },
  {
    id: 'venue_manager', label: 'Venue Manager / GM', domain: 'venue_management', kind: 'role',
    description: 'General manager for the venue. Business owner of the building; production reports up.',
    synonyms: ['GM', 'General Manager', 'Venue GM'],
    relatedTo: ['production_manager_venue', 'box_office_manager'],
  },
  {
    id: 'box_office_manager', label: 'Box Office Manager', domain: 'venue_operations', kind: 'role',
    description: 'Owns ticketing, will-call, and guest-list mechanics.',
    synonyms: ['BOM', 'Box Office'],
    relatedTo: ['guest_list', 'credentials'],
  },
  {
    id: 'stage_manager_venue', label: 'Stage Manager (Venue)', domain: 'stage_management', kind: 'role',
    description: 'Owns the deck and calls the show from the venue side; enforces changeover and cue timing.',
    synonyms: ['SM', 'Stage Manager'],
    relatedTo: ['production_manager_venue', 'stagehand'],
  },
  {
    id: 'head_electrician', label: 'Head Electrician', domain: 'power', kind: 'role',
    description: 'Owns temporary and house power distribution. Safety-critical role.',
    synonyms: ['Head Elec', 'House Electrician', 'Chief Electrician'],
    relatedTo: ['power_distro', 'stagehand'],
  },
  {
    id: 'rigger', label: 'Rigger', domain: 'rigging', kind: 'role',
    description: 'Trained personnel who hang and secure overhead points. Ground riggers work the floor; up-riggers work in the grid or catwalks. Certification requirements vary by region/union.',
    synonyms: ['Ground Rigger', 'Up Rigger', 'Head Rigger'],
    variability: [
      { dimension: 'region', note: 'ETCP certification is common in North America but not universally required. Some markets rely on IRATA / IPAF.' },
      { dimension: 'union', note: 'IATSE locals often require carded riggers; non-union venues rely on vendor certification.' },
    ],
    relatedTo: ['chain_motor', 'rig_plot', 'safety'],
  },
  {
    id: 'stagehand', label: 'Stagehand', domain: 'stagehands', kind: 'role',
    description: 'General local labor for load-in, changeover, and load-out. Sometimes split into loaders, pushers, and departmental hands.',
    synonyms: ['Hand', 'Local Hand', 'Loader', 'Pusher'],
    variability: [
      { dimension: 'union', note: 'Minimum call length, break schedule, and rate vary by local. IATSE locals commonly require 4-hour minimum calls; non-union varies by venue.' },
      { dimension: 'production_scale', note: 'Club shows may run zero hands; arena tours typically call dozens per department.' },
    ],
    relatedTo: ['stage_manager_venue', 'production_manager_venue'],
  },
  {
    id: 'runner', label: 'Runner', domain: 'hospitality', kind: 'role',
    description: 'Local staff/volunteer who handles ad-hoc errands: airport pickups, pharmacy runs, catering top-ups.',
    synonyms: ['Day Runner', 'Show Runner (runner)'],
    relatedTo: ['tour_manager', 'hospitality'],
  },
  {
    id: 'security_lead', label: 'Head of Security', domain: 'security', kind: 'role',
    description: 'Owns the venue security plan: perimeter, stage-front, bag checks, incident response.',
    synonyms: ['HOS', 'Security Director', 'Head of Security'],
    relatedTo: ['credentials', 'fire_life_safety'],
  },
  {
    id: 'promoter_rep', label: 'Promoter Representative', domain: 'promoters', kind: 'role',
    description: 'On-site representative of the promoter of record. Handles settlement paperwork, artist payment, and any promoter-side issues.',
    synonyms: ['Promoter Rep', 'Promoter'],
    relatedTo: ['promoter_of_record', 'settlement'],
  },
  {
    id: 'promoter_of_record', label: 'Promoter of Record', domain: 'promoters', kind: 'entity',
    description: 'The company financially responsible for the show. Distinct from any co-promoter or the on-site promoter rep.',
    synonyms: ['Promoter', 'Presenting Promoter'],
    relatedTo: ['settlement', 'booking_agent'],
  },

  // ── Phases / Events ──────────────────────────────────────────────────────
  {
    id: 'load_in', label: 'Load-In', domain: 'schedule', kind: 'phase',
    description: 'The window when the tour rolls in and unloads equipment. Begins with truck arrival, ends when the deck is ready for soundcheck. Includes rigging up-time.',
    synonyms: ['Load-In', 'Load In', 'LI'],
    relatedTo: ['rigging', 'stagehand', 'trucking'],
  },
  {
    id: 'soundcheck', label: 'Soundcheck', domain: 'schedule', kind: 'phase',
    description: 'Test of the audio/monitor system with the performers before doors. Order and duration are set by the tour and confirmed in advance.',
    synonyms: ['Sound Check', 'SC', 'Line Check (partial)'],
    relatedTo: ['foh_engineer', 'monitor_engineer'],
  },
  {
    id: 'doors', label: 'Doors', domain: 'schedule', kind: 'phase',
    description: 'The moment the venue opens to ticket holders. Requires stage-clear, fire-marshal walk-through, and security in position.',
    synonyms: ['House Open', 'Doors Time'],
    relatedTo: ['security', 'fire_life_safety'],
  },
  {
    id: 'show_time', label: 'Show Time', domain: 'schedule', kind: 'phase',
    description: 'Scheduled headliner start. Openers may be scheduled independently. Show time is often listed on the ticket while doors is not.',
    synonyms: ['Show', 'Set Time (headliner)', 'Downbeat'],
    relatedTo: ['doors', 'curfew'],
  },
  {
    id: 'curfew', label: 'Curfew', domain: 'schedule', kind: 'phase',
    description: 'Latest allowed sound in the venue. Set by municipality, permit, or venue policy. Overages typically trigger fines paid by the promoter or artist per the deal.',
    synonyms: ['Hard Curfew', 'Sound Curfew', 'Noise Curfew'],
    variability: [
      { dimension: 'region', note: 'Curfew rules are jurisdictional. Some venues have no curfew; others have strict municipal noise ordinances.' },
    ],
    relatedTo: ['show_time', 'settlement'],
  },
  {
    id: 'load_out', label: 'Load-Out', domain: 'schedule', kind: 'phase',
    description: 'Breakdown of the show and reloading the trucks. Starts immediately after last note; ends when the venue is clear.',
    synonyms: ['Load-Out', 'Load Out', 'LO'],
    relatedTo: ['stagehand', 'trucking'],
  },
  {
    id: 'changeover', label: 'Changeover', domain: 'schedule', kind: 'phase',
    description: 'The transition between acts on a multi-band bill. Owned by the stage manager. Length constrained by the schedule and by union break rules.',
    synonyms: ['Set Change', 'Reset'],
    relatedTo: ['stage_manager_venue', 'stagehand'],
  },
  {
    id: 'show_advance', label: 'Show Advance', domain: 'show_advancement', kind: 'phase',
    description: 'The multi-week process of confirming show details between tour and venue before the day of show.',
    synonyms: ['Advance', 'Advancing', 'Advance Process'],
    relatedTo: ['advance_email', 'production_schedule'],
  },
  {
    id: 'settlement', label: 'Settlement', domain: 'settlement', kind: 'phase',
    description: 'Post-show financial reconciliation between the promoter, venue, and tour. Ticket revenue, expenses, taxes, and merch splits are finalized here.',
    synonyms: ['Show Settlement', 'Final Settlement'],
    relatedTo: ['tour_manager', 'promoter_rep'],
  },

  // ── Documents ────────────────────────────────────────────────────────────
  {
    id: 'technical_rider', label: 'Technical Rider', domain: 'documents', kind: 'document',
    description: 'The tour\'s technical requirements: audio, lights, video, backline, power, labor. Attached to the contract but frequently renegotiated in advance.',
    synonyms: ['Tech Rider', 'Rider (tech)'],
    relatedTo: ['hospitality_rider', 'stage_plot', 'input_list'],
  },
  {
    id: 'hospitality_rider', label: 'Hospitality Rider', domain: 'documents', kind: 'document',
    description: 'The tour\'s dressing-room, catering, and hospitality requirements.',
    synonyms: ['Hosp Rider', 'Rider (hosp)'],
    relatedTo: ['catering', 'dressing_rooms'],
  },
  {
    id: 'stage_plot', label: 'Stage Plot', domain: 'documents', kind: 'document',
    description: 'Diagram of the on-stage layout: instrument positions, monitor wedges, risers, microphones. Used by stage crew and monitor engineer.',
    synonyms: ['Stage Diagram', 'Plot (stage)'],
    relatedTo: ['input_list', 'stage_management'],
  },
  {
    id: 'input_list', label: 'Input List', domain: 'documents', kind: 'document',
    description: 'Channel-by-channel list of every audio input: microphone/DI, position, phantom, notes. Feeds the patch list.',
    synonyms: ['Input Sheet', 'Channel List'],
    relatedTo: ['patch_list', 'stage_plot'],
  },
  {
    id: 'patch_list', label: 'Patch List', domain: 'documents', kind: 'document',
    description: 'Console-facing map of inputs to console channels/subgroups. Derived from the input list plus console limitations.',
    synonyms: ['Patch Sheet'],
    relatedTo: ['input_list', 'foh_engineer'],
  },
  {
    id: 'rig_plot', label: 'Rig Plot', domain: 'documents', kind: 'document',
    description: 'Overhead diagram showing hang points, motors, and cable paths. Reviewed by the venue rigger against the venue capacity plot.',
    synonyms: ['Rigging Plot', 'Hang Plot', 'Weight Plot'],
    relatedTo: ['rigger', 'chain_motor'],
  },
  {
    id: 'lighting_plot', label: 'Lighting Plot', domain: 'documents', kind: 'document',
    description: 'Overhead diagram of the lighting rig: instrument types, positions, focus.',
    synonyms: ['Light Plot', 'LX Plot'],
    relatedTo: ['lighting_designer'],
  },
  {
    id: 'venue_tech_pack', label: 'Venue Tech Pack', domain: 'documents', kind: 'document',
    description: 'The venue\'s published specifications: stage dimensions, power, rigging capacity, house PA, house lighting, load-in access.',
    synonyms: ['Tech Pack', 'Venue Spec', 'Technical Specifications'],
    relatedTo: ['production_manager_venue', 'venue_operations'],
  },
  {
    id: 'production_schedule', label: 'Production Schedule', domain: 'documents', kind: 'document',
    description: 'The day-of-show timeline agreed between tour and venue. Baseline schema: truck arrival → load-in → soundcheck → doors → openers → headliner → curfew → load-out.',
    synonyms: ['Day Sheet', 'Day of Show Schedule', 'DOS'],
    relatedTo: ['show_advance', 'schedule'],
  },
  {
    id: 'advance_email', label: 'Advance Email', domain: 'documents', kind: 'document',
    description: 'Emails exchanged between tour PM and venue PM to lock in show details. The dominant source of show-specific facts.',
    synonyms: ['Advance Thread', 'Advance Message'],
    relatedTo: ['show_advance'],
  },
  {
    id: 'guest_list', label: 'Guest List', domain: 'venue_operations', kind: 'document',
    description: 'List of comped attendees. Split between artist guests, promoter guests, venue guests. Manages will-call at the box office.',
    synonyms: ['GL', 'Comp List'],
    relatedTo: ['box_office_manager'],
  },
  {
    id: 'settlement_sheet', label: 'Settlement Sheet', domain: 'documents', kind: 'document',
    description: 'Line-item statement of ticket revenue, deductions, artist payout, and taxes signed at settlement.',
    synonyms: ['Settlement Statement'],
    relatedTo: ['settlement'],
  },

  // ── Equipment / Systems ──────────────────────────────────────────────────
  {
    id: 'pa_system', label: 'PA System', domain: 'audio', kind: 'equipment',
    description: 'The main sound reinforcement system: line-array boxes, subwoofers, front-fills, delays, amps, and processing.',
    synonyms: ['House PA', 'Main PA', 'Sound System'],
    relatedTo: ['line_array_boxes', 'subwoofer_count', 'systems_tech'],
  },
  {
    id: 'line_array_boxes', label: 'Line Array Boxes', domain: 'audio', kind: 'metric',
    description: 'Count of line-array elements hung per side; a common proxy for PA scale.',
    synonyms: ['Boxes per Side', 'LA Boxes'],
    relatedTo: ['pa_system', 'rigging'],
  },
  {
    id: 'subwoofer_count', label: 'Subwoofer Count', domain: 'audio', kind: 'metric',
    description: 'Total subwoofers deployed. Configuration (flown, ground-stacked, cardioid) affects rigging and floor plan.',
    synonyms: ['Sub Count', 'Subs'],
    relatedTo: ['pa_system'],
  },
  {
    id: 'iem', label: 'In-Ear Monitor', domain: 'audio', kind: 'equipment',
    description: 'Wireless in-ear monitors used in place of stage wedges. Requires RF coordination.',
    synonyms: ['IEMs', 'In-Ears', 'Ears'],
    relatedTo: ['rf_coordinator', 'monitor_engineer'],
  },
  {
    id: 'wireless_channels', label: 'Wireless Channels', domain: 'rf', kind: 'metric',
    description: 'Number of simultaneously operating wireless microphone + IEM channels. Must fit within available spectrum and be coordinated to prevent interference.',
    synonyms: ['RF Channels', 'Wireless Count'],
    variability: [
      { dimension: 'region', note: 'Available spectrum varies by country and by post-incentive-auction reallocation.' },
    ],
    relatedTo: ['rf_coordinator', 'iem'],
  },
  {
    id: 'chain_motor', label: 'Chain Motor', domain: 'rigging', kind: 'equipment',
    description: 'Electric chain hoist used to hang audio, lighting, video, or scenic elements. Count and capacity are constrained by the venue rig plot.',
    synonyms: ['Motor', 'Chain Hoist', 'CM-1', 'CM-2', 'D8'],
    relatedTo: ['rig_plot', 'rigger'],
  },
  {
    id: 'lighting_console', label: 'Lighting Console', domain: 'lighting', kind: 'equipment',
    description: 'Programming/playback desk for the lighting rig.',
    synonyms: ['Light Board', 'LX Desk'],
    relatedTo: ['lighting_designer'],
  },
  {
    id: 'led_wall', label: 'LED Wall', domain: 'video', kind: 'equipment',
    description: 'Modular LED display used as the main scenic video surface. Weight and power draw are significant; must be included in rig and power plans.',
    synonyms: ['Video Wall', 'LED Screen', 'Panels'],
    relatedTo: ['video_engineer', 'power_distro'],
  },
  {
    id: 'imag', label: 'IMAG', domain: 'video', kind: 'equipment',
    description: 'Image Magnification — live cameras feeding side-screens for audience sightlines.',
    synonyms: ['IMAG', 'Image Magnification'],
    relatedTo: ['video_engineer'],
  },
  {
    id: 'power_distro', label: 'Power Distribution', domain: 'power', kind: 'equipment',
    description: 'Company switches, distros, and cable used to supply power to audio, lights, video, and backline. Sized to the show\'s peak draw with headroom.',
    synonyms: ['Distro', 'Distribution', 'Company Switch', 'Cam-Lok tie-in'],
    relatedTo: ['head_electrician', 'power_service'],
  },
  {
    id: 'power_service', label: 'Power Service', domain: 'power', kind: 'metric',
    description: 'The electrical service the venue can supply, typically expressed as amperage and phases at a voltage (e.g. 400A 3-phase).',
    synonyms: ['Service', 'Shore Power', 'Bus Power (venue)'],
    variability: [
      { dimension: 'region', note: 'Voltage and phase standards differ globally. Tie-in connectors also vary (Cam-Lok in NA is not universal).' },
      { dimension: 'production_scale', note: 'Clubs may only offer 60-100A single phase; arenas commonly offer several hundred amps 3-phase per department.' },
    ],
    relatedTo: ['head_electrician', 'power_distro'],
  },

  // ── Facilities / Hospitality ─────────────────────────────────────────────
  {
    id: 'dressing_room', label: 'Dressing Room', domain: 'dressing_rooms', kind: 'facility',
    description: 'Private rooms for the artist and crew. Count, size, and lockability vary by venue.',
    synonyms: ['DR', 'Green Room (loosely)'],
    relatedTo: ['hospitality_rider'],
  },
  {
    id: 'production_office', label: 'Production Office', domain: 'production_offices', kind: 'facility',
    description: 'Working office space for the tour and venue production managers. Requires desks, wifi, printer, and phone.',
    synonyms: ['Prod Office', 'PO'],
    relatedTo: ['production_manager_venue', 'tour_production_manager'],
  },
  {
    id: 'catering_meal', label: 'Catered Meal', domain: 'catering', kind: 'event',
    description: 'A hot meal service for artist and crew. Advance emails typically specify meal counts, service time, and dietary restrictions.',
    synonyms: ['Meal', 'Hot Meal'],
    relatedTo: ['hospitality_rider'],
  },
  {
    id: 'parking_spot', label: 'Parking Spot', domain: 'parking', kind: 'metric',
    description: 'Reserved parking for tour vehicles, crew personal vehicles, and VIPs.',
    synonyms: ['Space', 'Spot'],
    relatedTo: ['trucking', 'buses'],
  },
  {
    id: 'truck_bay', label: 'Truck Bay', domain: 'transportation', kind: 'facility',
    description: 'Loading position for a semi at the venue dock. Bays constrain simultaneous unload capacity.',
    synonyms: ['Bay', 'Dock'],
    relatedTo: ['trucking', 'load_in'],
  },
  {
    id: 'bus_parking', label: 'Bus Parking', domain: 'buses', kind: 'facility',
    description: 'Overnight tour-bus parking. Often requires shore-power tie-ins for HVAC and appliances.',
    synonyms: ['Bus Lot', 'Coach Parking'],
    relatedTo: ['power_service', 'transportation'],
  },
  {
    id: 'credential', label: 'Credential', domain: 'credentials', kind: 'document',
    description: 'Physical or digital access pass identifying role and area access rights.',
    synonyms: ['Pass', 'Laminate', 'Wristband', 'AAA (all-access)'],
    relatedTo: ['security', 'guest_list'],
  },

  // ── Safety / Ops ─────────────────────────────────────────────────────────
  {
    id: 'fire_marshal_walkthrough', label: 'Fire Marshal Walk-Through', domain: 'fire_life_safety', kind: 'event',
    description: 'Pre-doors inspection by the local fire marshal or venue FLS lead. Sightlines, egress, pyro, and staging must be cleared before doors.',
    synonyms: ['Fire Walk', 'FLS Walk'],
    relatedTo: ['doors', 'security_lead'],
  },
  {
    id: 'pyro_permit', label: 'Pyro Permit', domain: 'fire_life_safety', kind: 'document',
    description: 'Jurisdictional permit for pyrotechnic effects. Required in advance; venue policy may prohibit pyro regardless of permit.',
    synonyms: ['Pyrotechnics Permit', 'Effects Permit'],
    variability: [
      { dimension: 'region', note: 'Permit authority (city, county, state fire marshal) and lead time vary significantly.' },
    ],
    relatedTo: ['fire_marshal_walkthrough'],
  },
  {
    id: 'rig_capacity', label: 'Rig Capacity', domain: 'rigging', kind: 'metric',
    description: 'Maximum weight the venue grid can support, expressed per point and total. Exceeding capacity is a safety-critical failure.',
    synonyms: ['Grid Capacity', 'Point Load Limit'],
    relatedTo: ['rig_plot', 'rigger'],
  },
];

// ── Ambiguous terms (context-dependent) ─────────────────────────────────────
// Registered separately so we NEVER auto-normalize them. Consumers must
// resolve by context.

const AMBIGUOUS_TERMS = [
  {
    term: 'PM',
    candidates: [
      { conceptId: 'production_manager_venue',   contexts: ['advance_email', 'venue', 'operations'] },
      { conceptId: 'tour_production_manager',    contexts: ['tour', 'touring party'] },
      { conceptId: 'promoter_rep',               contexts: ['settlement', 'promoter'] },
      // Note: also means "post meridiem" and "project manager" in general English.
    ],
    fallback: 'unknown',
  },
  {
    term: 'TM',
    candidates: [
      { conceptId: 'tour_manager', contexts: ['advance', 'tour', 'day sheet', 'settlement'] },
    ],
    fallback: 'tour_manager',
  },
  {
    term: 'SM',
    candidates: [
      { conceptId: 'stage_manager_venue', contexts: ['deck', 'stage', 'changeover'] },
    ],
    fallback: 'stage_manager_venue',
  },
  {
    term: 'LD',
    candidates: [
      { conceptId: 'lighting_designer', contexts: ['lighting', 'plot', 'cues'] },
    ],
    fallback: 'lighting_designer',
  },
  {
    term: 'FOH',
    candidates: [
      { conceptId: 'foh_engineer', contexts: ['audio', 'mix'] },
    ],
    fallback: 'foh_engineer',
  },
  {
    term: 'MON',
    candidates: [
      { conceptId: 'monitor_engineer', contexts: ['audio', 'wedge', 'iem', 'mix'] },
    ],
    fallback: 'monitor_engineer',
  },
  {
    term: 'plot',
    candidates: [
      { conceptId: 'stage_plot',    contexts: ['stage', 'mic', 'input', 'monitor'] },
      { conceptId: 'lighting_plot', contexts: ['lighting', 'fixture', 'focus'] },
      { conceptId: 'rig_plot',      contexts: ['rig', 'motor', 'hang', 'point', 'weight'] },
    ],
    fallback: 'unknown',
  },
  {
    term: 'rider',
    candidates: [
      { conceptId: 'technical_rider',   contexts: ['audio', 'lights', 'stage', 'backline', 'power', 'labor'] },
      { conceptId: 'hospitality_rider', contexts: ['dressing', 'catering', 'towels', 'meal'] },
    ],
    fallback: 'unknown',
  },
  {
    term: 'push',
    candidates: [
      { conceptId: 'load_in', contexts: ['load', 'truck', 'stagehand'] },
      // In video contexts "push" refers to camera moves — not modeled here.
    ],
    fallback: 'unknown',
  },
];

// ── Normalization synonyms (SAFE — no ambiguity) ────────────────────────────
// These can be normalized without context. Keep entries with clear one-to-one
// mapping only. Anything ambiguous belongs in AMBIGUOUS_TERMS above.

const SAFE_SYNONYMS = [
  { canonical: 'load_in',    forms: ['load in', 'load-in', 'loadin', 'load  in'] },
  { canonical: 'load_out',   forms: ['load out', 'load-out', 'loadout'] },
  { canonical: 'soundcheck', forms: ['sound check', 'sound-check', 'soundcheck'] },
  { canonical: 'iem',        forms: ['in-ear monitor', 'in ear monitor', 'in-ears', 'in ears'] },
  { canonical: 'foh_engineer',     forms: ['front of house', 'front-of-house engineer'] },
  { canonical: 'monitor_engineer', forms: ['monitor engineer', 'monitor mixer'] },
  { canonical: 'production_manager_venue', forms: ['venue production manager', 'house production manager'] },
  { canonical: 'tour_production_manager',  forms: ['tour production manager', 'touring production manager'] },
  { canonical: 'stage_plot',   forms: ['stage plot', 'stage diagram'] },
  { canonical: 'input_list',   forms: ['input list', 'input sheet', 'channel list'] },
  { canonical: 'guest_list',   forms: ['guest list', 'comp list', 'gl (guest list)'] },
  { canonical: 'led_wall',     forms: ['led wall', 'video wall', 'led screen'] },
];

// ── Workflows ───────────────────────────────────────────────────────────────

const WORKFLOWS = [
  {
    id: 'show_advance',
    label: 'Show Advance',
    description: 'End-to-end process from confirmed booking through settlement.',
    stages: [
      { name: 'confirmation',        typicalWindow: '4–12 weeks out', owner: 'booking_agent', description: 'Deal memo signed; show handed to promoter and tour.' },
      { name: 'initial_contact',     typicalWindow: '3–6 weeks out',  owner: 'production_manager_venue', description: 'Venue PM introduces to tour PM; sends venue tech pack.' },
      { name: 'rider_review',        typicalWindow: '2–5 weeks out',  owner: 'production_manager_venue', description: 'Technical + hospitality riders reviewed against venue capabilities. Deviations negotiated.' },
      { name: 'technical_advance',   typicalWindow: '1–3 weeks out',  owner: 'tour_production_manager',  description: 'Confirm audio, lights, video, rigging, power, labor counts, and schedule.' },
      { name: 'day_of_show_lock',    typicalWindow: '3–7 days out',   owner: 'production_manager_venue', description: 'Publish day-of-show schedule; confirm catering, credentials, parking.' },
      { name: 'day_of_show',         typicalWindow: '0 days',         owner: 'production_manager_venue', description: 'Execute the schedule from load-in through load-out.' },
      { name: 'settlement',          typicalWindow: 'same night',     owner: 'promoter_rep',             description: 'Reconcile revenue and expenses with tour manager.' },
    ],
    standardInfoRequired: [
      'showTime', 'doorsTime', 'loadInTime', 'soundcheckTime', 'curfewTime', 'loadOutTime',
      'tourPMContact', 'headlinerFOH', 'headlinerMON',
      'technicalRider', 'hospitalityRider', 'stagePlot', 'inputList',
      'wirelessChannels', 'chainMotorCount', 'powerRequirements',
      'truckCount', 'busCount', 'parkingSpaces',
      'mealCounts', 'dietaryRestrictions', 'dressingRoomCount',
      'guestListCount', 'credentialCount',
      'pyroRequested', 'flownElements', 'rigWeight',
    ],
    commonExceptions: [
      { case: 'festival_slot',      deviation: 'Compressed timeline. Load-in is a changeover; soundcheck may be replaced by line check.' },
      { case: 'radio_promo',        deviation: 'Skeleton crew and rig; often no rider.' },
      { case: 'private_event',      deviation: 'Client-facing rules may override venue defaults; NDAs common.' },
      { case: 'benefit_show',       deviation: 'Talent added late; multiple artist managers to coordinate.' },
      { case: 'artist_walk_up',     deviation: 'Artist arrives after doors; soundcheck skipped.' },
    ],
    commonConflicts: [
      { case: 'curfew_vs_setlist',    consequence: 'Tour must trim show or accept municipal/venue fine.' },
      { case: 'rig_weight_vs_capacity', consequence: 'SAFETY. Show scale must be reduced or approach re-engineered. Not a negotiation.' },
      { case: 'power_undersize',      consequence: 'SAFETY. Vendor generator required or scale reduced.' },
      { case: 'rf_congestion',        consequence: 'Wireless channel plan re-coordinated; some mics moved to hardline.' },
      { case: 'load_in_stacking',     consequence: 'Truck arrivals rescheduled; dock stagger enforced.' },
    ],
  },
  {
    id: 'load_in_workflow',
    label: 'Load-In',
    description: 'From first truck arrival to soundcheck-ready deck.',
    stages: [
      { name: 'truck_arrival',   typicalWindow: '00:00–00:30', owner: 'tour_production_manager',  description: 'Trucks stage; dock order confirmed.' },
      { name: 'rigging_up',      typicalWindow: '00:15–02:00', owner: 'rigger',                   description: 'Chain motors up; points hung.' },
      { name: 'audio_deploy',    typicalWindow: '01:00–03:00', owner: 'foh_engineer',             description: 'PA flown; monitors on deck; systems tuning.' },
      { name: 'lighting_deploy', typicalWindow: '01:00–03:00', owner: 'lighting_designer',        description: 'Lighting focused; console programmed as needed.' },
      { name: 'video_deploy',    typicalWindow: '01:00–03:00', owner: 'video_engineer',           description: 'LED assembled and mapped; playback tested.' },
      { name: 'backline_set',    typicalWindow: '02:00–03:30', owner: 'stagehand',                description: 'Instruments and risers positioned per stage plot.' },
      { name: 'ready_for_check', typicalWindow: '03:00–04:00', owner: 'stage_manager_venue',      description: 'Deck cleared; artists brought to stage.' },
    ],
    variability: [
      { dimension: 'production_scale', note: 'Duration ranges from ~1 hour (club) to 8–14 hours (arena tour).' },
      { dimension: 'union',            note: 'Break schedule and minimum call length are set by the local.' },
    ],
  },
  {
    id: 'load_out_workflow',
    label: 'Load-Out',
    description: 'From last note to venue clear.',
    stages: [
      { name: 'strike_start',      typicalWindow: '00:00–00:15', owner: 'stage_manager_venue', description: 'Immediately after final bow.' },
      { name: 'backline_pack',     typicalWindow: '00:00–00:30', owner: 'stagehand',           description: 'Instruments cased and rolled.' },
      { name: 'audio_lights_video',typicalWindow: '00:15–01:30', owner: 'stagehand',           description: 'Depts break down in parallel.' },
      { name: 'rigging_down',      typicalWindow: '01:00–02:30', owner: 'rigger',              description: 'Motors down; points struck.' },
      { name: 'truck_load',        typicalWindow: '00:30–03:00', owner: 'tour_production_manager', description: 'Reverse-order truck pack.' },
    ],
  },
  {
    id: 'settlement_workflow',
    label: 'Settlement',
    stages: [
      { name: 'ticket_audit',    owner: 'box_office_manager', description: 'Reconcile scanned vs sold vs comped.' },
      { name: 'expense_review',  owner: 'promoter_rep',       description: 'Attach all show expenses.' },
      { name: 'artist_payout',   owner: 'promoter_rep',       description: 'Cut check per deal.' },
      { name: 'signoff',         owner: 'tour_manager',       description: 'Signs settlement sheet.' },
    ],
    variability: [
      { dimension: 'promoter', note: 'Deal structure (flat, versus, door deal, four-wall) drives the calculation.' },
    ],
  },
];

// ── Operational consequences ────────────────────────────────────────────────

const OPERATIONAL_CONSEQUENCES = {
  missing_curfew:          { severity: 'high',     consequence: 'Municipal fine and potential impact on venue license/permits.' },
  exceeded_rig_capacity:   { severity: 'critical', consequence: 'Structural risk to venue and crew. Must be resolved before any load.' },
  undersized_power:        { severity: 'critical', consequence: 'Breaker trips mid-show and possible gear damage. Requires vendor generator or scale reduction.' },
  rf_frequency_conflict:   { severity: 'high',     consequence: 'Dropouts and interference during performance.' },
  unpermitted_pyro:        { severity: 'critical', consequence: 'Fire marshal shutdown; potential criminal exposure.' },
  unqualified_rigger:      { severity: 'critical', consequence: 'OSHA / regional H&S violation; insurance void.' },
  short_labor_call:        { severity: 'medium',   consequence: 'Late deck, missed soundcheck, cascading schedule slip.' },
  meal_undercount:         { severity: 'medium',   consequence: 'Crew morale issue; possible rider breach.' },
  dietary_mishandled:      { severity: 'high',     consequence: 'Allergen exposure; artist unable to perform.' },
  credential_shortage:     { severity: 'medium',   consequence: 'Access-control breakdown; escorts required.' },
  guest_list_overflow:     { severity: 'low',      consequence: 'Ticket revenue impact.' },
  unclear_promoter:        { severity: 'high',     consequence: 'Settlement stalls; artist not paid.' },
};

module.exports = {
  DOMAINS,
  CONCEPTS,
  AMBIGUOUS_TERMS,
  SAFE_SYNONYMS,
  WORKFLOWS,
  OPERATIONAL_CONSEQUENCES,
};
