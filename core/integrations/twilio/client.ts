/**
 * Twilio REST API client for call control.
 */

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  phoneNumber?: string; // For outbound calls
}

export interface TwilioCallResult {
  success: boolean;
  callSid?: string;
  error?: string;
}

export interface TerminateCallResult {
  success: boolean;
  error?: string;
}

export interface ConferenceResult {
  success: boolean;
  conferenceSid?: string;
  error?: string;
}

export interface ParticipantResult {
  success: boolean;
  callSid?: string;
  error?: string;
}

// =============================================================================
// CORE API HELPERS
// =============================================================================

function getAuthHeader(config: TwilioConfig): string {
  return `Basic ${btoa(`${config.accountSid}:${config.authToken}`)}`;
}

function getTwilioBaseUrl(config: TwilioConfig): string {
  return `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}`;
}

// =============================================================================
// CALL CONTROL
// =============================================================================

/**
 * Terminate a Twilio call by updating its status to "completed".
 * This is the proper way to hang up—closing the WebSocket alone doesn't end the call.
 */
export async function terminateCall(
  config: TwilioConfig,
  callSid: string
): Promise<TerminateCallResult> {
  const url = `${getTwilioBaseUrl(config)}/Calls/${callSid}.json`;

  try {
    console.log(`Terminating call ${callSid} via Twilio API`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': getAuthHeader(config),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'Status=completed',
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`Twilio terminate error (${response.status}):`, error);
      return {
        success: false,
        error: `Twilio API error: ${response.status}`,
      };
    }

    console.log(`Call ${callSid} terminated successfully`);
    return { success: true };
  } catch (e) {
    console.error('terminateCall error:', e);
    return {
      success: false,
      error: String(e),
    };
  }
}

/**
 * Update a call with new TwiML instructions.
 * Used for redirecting calls to conferences, hold music, etc.
 */
export async function updateCall(
  config: TwilioConfig,
  callSid: string,
  twiml: string
): Promise<TwilioCallResult> {
  const url = `${getTwilioBaseUrl(config)}/Calls/${callSid}.json`;

  try {
    console.log(`Updating call ${callSid} with new TwiML`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': getAuthHeader(config),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ Twiml: twiml }).toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`Twilio update error (${response.status}):`, error);
      return {
        success: false,
        error: `Twilio API error: ${response.status}`,
      };
    }

    const data = await response.json() as { sid: string };
    console.log(`Call ${callSid} updated successfully`);
    return { success: true, callSid: data.sid };
  } catch (e) {
    console.error('updateCall error:', e);
    return {
      success: false,
      error: String(e),
    };
  }
}

/**
 * Create an outbound call.
 */
export async function createCall(
  config: TwilioConfig,
  to: string,
  twiml: string,
  from?: string
): Promise<TwilioCallResult> {
  const url = `${getTwilioBaseUrl(config)}/Calls.json`;
  const fromNumber = from || config.phoneNumber;

  if (!fromNumber) {
    return { success: false, error: 'No from phone number configured' };
  }

  try {
    console.log(`Creating outbound call to ${to}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': getAuthHeader(config),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        To: to,
        From: fromNumber,
        Twiml: twiml,
      }).toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`Twilio create call error (${response.status}):`, error);
      return {
        success: false,
        error: `Twilio API error: ${response.status}`,
      };
    }

    const data = await response.json() as { sid: string };
    console.log(`Outbound call created: ${data.sid}`);
    return { success: true, callSid: data.sid };
  } catch (e) {
    console.error('createCall error:', e);
    return {
      success: false,
      error: String(e),
    };
  }
}

/**
 * Create an outbound call using a URL for TwiML (instead of inline TwiML).
 * Useful for whisper announcements where TwiML is served dynamically.
 */
export async function createOutboundCallWithUrl(
  config: TwilioConfig,
  to: string,
  twimlUrl: string,
  options?: {
    from?: string;
    timeout?: number;
    statusCallback?: string;
    statusCallbackMethod?: 'GET' | 'POST';
    statusCallbackEvent?: string[];
  }
): Promise<TwilioCallResult> {
  const url = `${getTwilioBaseUrl(config)}/Calls.json`;
  const fromNumber = options?.from || config.phoneNumber;

  if (!fromNumber) {
    return { success: false, error: 'No from phone number configured' };
  }

  try {
    console.log(`Creating outbound call to ${to} with TwiML URL: ${twimlUrl}`);

    const params = new URLSearchParams({
      To: to,
      From: fromNumber,
      Url: twimlUrl,
      Method: 'POST',
    });

    if (options?.timeout) params.set('Timeout', String(options.timeout));
    if (options?.statusCallback) params.set('StatusCallback', options.statusCallback);
    if (options?.statusCallbackMethod) params.set('StatusCallbackMethod', options.statusCallbackMethod);
    if (options?.statusCallbackEvent) {
      options.statusCallbackEvent.forEach(event => params.append('StatusCallbackEvent', event));
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': getAuthHeader(config),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`Twilio create call with URL error (${response.status}):`, error);
      return {
        success: false,
        error: `Twilio API error: ${response.status} - ${error}`,
      };
    }

    const data = await response.json() as { sid: string };
    console.log(`Outbound call created with URL: ${data.sid}`);
    return { success: true, callSid: data.sid };
  } catch (e) {
    console.error('createOutboundCallWithUrl error:', e);
    return {
      success: false,
      error: String(e),
    };
  }
}

// =============================================================================
// CONFERENCE OPERATIONS
// =============================================================================

/**
 * Get conference details by friendly name.
 */
export async function getConference(
  config: TwilioConfig,
  conferenceName: string
): Promise<{ success: boolean; conference?: { sid: string; status: string }; error?: string }> {
  const url = `${getTwilioBaseUrl(config)}/Conferences.json?FriendlyName=${encodeURIComponent(conferenceName)}&Status=in-progress`;

  try {
    const response = await fetch(url, {
      headers: { 'Authorization': getAuthHeader(config) },
    });

    if (!response.ok) {
      return { success: false, error: `Twilio API error: ${response.status}` };
    }

    const data = await response.json() as { conferences: Array<{ sid: string; status: string }> };
    const conference = data.conferences?.[0];

    if (!conference) {
      return { success: false, error: 'Conference not found' };
    }

    return { success: true, conference };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

/**
 * Add a participant to a conference by calling them.
 */
export async function addParticipantToConference(
  config: TwilioConfig,
  conferenceSid: string,
  to: string,
  options?: {
    from?: string;
    earlyMedia?: boolean;
    beep?: boolean;
    record?: boolean;
    muted?: boolean;
    hold?: boolean;
    holdUrl?: string;
    statusCallback?: string;
    timeout?: number;
    /** TwiML URL to execute when participant answers (for whisper/announcement) */
    url?: string;
  }
): Promise<ParticipantResult> {
  const url = `${getTwilioBaseUrl(config)}/Conferences/${conferenceSid}/Participants.json`;
  const fromNumber = options?.from || config.phoneNumber;

  if (!fromNumber) {
    return { success: false, error: 'No from phone number configured' };
  }

  try {
    console.log(`Adding participant ${to} to conference ${conferenceSid}`);

    const params = new URLSearchParams({
      To: to,
      From: fromNumber,
    });

    if (options?.earlyMedia !== undefined) params.set('EarlyMedia', String(options.earlyMedia));
    if (options?.beep !== undefined) params.set('Beep', String(options.beep));
    if (options?.record !== undefined) params.set('Record', String(options.record));
    if (options?.muted !== undefined) params.set('Muted', String(options.muted));
    if (options?.hold !== undefined) params.set('Hold', String(options.hold));
    if (options?.holdUrl) params.set('HoldUrl', options.holdUrl);
    if (options?.statusCallback) params.set('StatusCallback', options.statusCallback);
    if (options?.timeout) params.set('Timeout', String(options.timeout));
    // URL to execute TwiML when participant answers (for whisper/announcement before joining)
    if (options?.url) params.set('Url', options.url);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': getAuthHeader(config),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`Twilio add participant error (${response.status}):`, error);
      return { success: false, error: `Twilio API error: ${response.status}` };
    }

    const data = await response.json() as { call_sid: string };
    console.log(`Participant added to conference, call SID: ${data.call_sid}`);
    return { success: true, callSid: data.call_sid };
  } catch (e) {
    console.error('addParticipantToConference error:', e);
    return { success: false, error: String(e) };
  }
}

/**
 * Update a conference participant (mute, hold, etc.)
 */
export async function updateParticipant(
  config: TwilioConfig,
  conferenceSid: string,
  callSid: string,
  options: {
    muted?: boolean;
    hold?: boolean;
    holdUrl?: string;
  }
): Promise<ParticipantResult> {
  const url = `${getTwilioBaseUrl(config)}/Conferences/${conferenceSid}/Participants/${callSid}.json`;

  try {
    const params = new URLSearchParams();
    if (options.muted !== undefined) params.set('Muted', String(options.muted));
    if (options.hold !== undefined) params.set('Hold', String(options.hold));
    if (options.holdUrl) params.set('HoldUrl', options.holdUrl);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': getAuthHeader(config),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      return { success: false, error: `Twilio API error: ${response.status}: ${error}` };
    }

    return { success: true, callSid };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

/**
 * Remove a participant from a conference.
 */
export async function removeParticipant(
  config: TwilioConfig,
  conferenceSid: string,
  callSid: string
): Promise<ParticipantResult> {
  const url = `${getTwilioBaseUrl(config)}/Conferences/${conferenceSid}/Participants/${callSid}.json`;

  try {
    const response = await fetch(url, {
      method: 'DELETE',
      headers: { 'Authorization': getAuthHeader(config) },
    });

    if (!response.ok && response.status !== 204) {
      const error = await response.text();
      return { success: false, error: `Twilio API error: ${response.status}: ${error}` };
    }

    console.log(`Participant ${callSid} removed from conference ${conferenceSid}`);
    return { success: true, callSid };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

/**
 * End a conference (kicks all participants).
 */
export async function endConference(
  config: TwilioConfig,
  conferenceSid: string
): Promise<ConferenceResult> {
  const url = `${getTwilioBaseUrl(config)}/Conferences/${conferenceSid}.json`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': getAuthHeader(config),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'Status=completed',
    });

    if (!response.ok) {
      const error = await response.text();
      return { success: false, error: `Twilio API error: ${response.status}: ${error}` };
    }

    console.log(`Conference ${conferenceSid} ended`);
    return { success: true, conferenceSid };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

// =============================================================================
// TWIML BUILDERS
// =============================================================================

/**
 * Generate TwiML to put caller into a conference with hold music.
 */
export function conferenceWithHoldTwiml(
  conferenceName: string,
  options?: {
    waitUrl?: string;
    beep?: boolean;
    startConferenceOnEnter?: boolean;
    endConferenceOnExit?: boolean;
  }
): string {
  const waitUrl = options?.waitUrl || 'http://twimlets.com/holdmusic?Bucket=com.twilio.music.classical';
  const beep = options?.beep ?? false;
  const startOnEnter = options?.startConferenceOnEnter ?? true;
  const endOnExit = options?.endConferenceOnExit ?? false;

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial>
    <Conference 
      beep="${beep}" 
      waitUrl="${waitUrl}"
      startConferenceOnEnter="${startOnEnter}"
      endConferenceOnExit="${endOnExit}"
    >${conferenceName}</Conference>
  </Dial>
</Response>`;
}

/**
 * Generate TwiML to dial a number directly (blind transfer).
 */
export function dialTwiml(
  number: string,
  options?: {
    callerId?: string;
    timeout?: number;
    record?: boolean;
  }
): string {
  const timeout = options?.timeout ?? 30;
  const record = options?.record ? 'record-from-answer' : 'do-not-record';
  const callerId = options?.callerId ? `callerId="${options.callerId}"` : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="${timeout}" record="${record}" ${callerId}>
    <Number>${number}</Number>
  </Dial>
</Response>`;
}

/**
 * Generate TwiML to join a conference (for after whisper announcement).
 */
export function conferenceJoinTwiml(
  conferenceName: string,
  options?: {
    beep?: boolean;
    endConferenceOnExit?: boolean;
  }
): string {
  const beep = options?.beep ?? false;
  const endOnExit = options?.endConferenceOnExit ?? true;

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial>
    <Conference beep="${beep}" endConferenceOnExit="${endOnExit}">${conferenceName}</Conference>
  </Dial>
</Response>`;
}

/**
 * Generate TwiML for voicemail.
 */
export function voicemailTwiml(options?: {
  maxLength?: number;
  transcribe?: boolean;
  playBeep?: boolean;
  finishOnKey?: string;
  recordingStatusCallback?: string;
}): string {
  const maxLength = options?.maxLength ?? 120;
  const transcribe = options?.transcribe ?? false;
  const playBeep = options?.playBeep ?? true;
  const finishOnKey = options?.finishOnKey ?? '#';
  const callback = options?.recordingStatusCallback 
    ? `recordingStatusCallback="${options.recordingStatusCallback}"` 
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Please leave a message after the beep. Press pound when finished.</Say>
  <Record 
    maxLength="${maxLength}" 
    transcribe="${transcribe}" 
    playBeep="${playBeep}"
    finishOnKey="${finishOnKey}"
    ${callback}
  />
  <Say>Thank you. Goodbye.</Say>
</Response>`;
}

/**
 * Generate TwiML for a bidirectional media stream.
 * Used for connecting calls to voice agents via WebSocket.
 */
export function mediaStreamTwiml(
  streamUrl: string,
  options?: {
    statusCallback?: string;
    statusCallbackMethod?: 'GET' | 'POST';
    record?: boolean | 'record-from-answer';
    customParameters?: Record<string, string>;
  }
): string {
  const statusCallback = options?.statusCallback 
    ? `statusCallback="${options.statusCallback}" statusCallbackMethod="${options.statusCallbackMethod || 'POST'}"` 
    : '';
  
  const record = options?.record 
    ? (options.record === true ? 'record="record-from-answer"' : `record="${options.record}"`)
    : '';
  
  // Build custom parameters XML
  const params = options?.customParameters 
    ? Object.entries(options.customParameters)
        .map(([name, value]) => `            <Parameter name="${name}" value="${escapeXml(value)}" />`)
        .join('\n')
    : '';
  
  const paramsBlock = params ? `\n${params}` : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect ${record}>
        <Stream url="${streamUrl}" ${statusCallback}>${paramsBlock}
        </Stream>
    </Connect>
</Response>`;
}

/**
 * Escape special XML characters.
 */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// =============================================================================
// OUTBOUND CALL ORCHESTRATION
// =============================================================================

export interface OutboundCallConfig {
  /** Twilio credentials */
  twilio: TwilioConfig;
  /** Phone number to call */
  to: string;
  /** Phone number to call from (overrides config.phoneNumber) */
  from?: string;
  /** Host URL for WebSocket stream (e.g., 'deepgram-phone-agent.agenticflows.workers.dev') */
  hostUrl: string;
  /** Agent path for WebSocket (e.g., '/agents/my-phone-agent') */
  agentPath: string;
  /** Unique instance ID for the call (defaults to generated ID) */
  instanceId?: string;
  /** Custom parameters to pass to the agent via WebSocket */
  customParameters?: Record<string, string>;
  /** Status callback URL for stream events */
  statusCallbackUrl?: string;
  /** Whether to record the call */
  record?: boolean;
  /** AMD (Answering Machine Detection) */
  machineDetection?: 'Enable' | 'DetectMessageEnd';
  /** Timeout for AMD (seconds, 3-60) */
  machineDetectionTimeout?: number;
  /** Async AMD callback URL */
  asyncAmdStatusCallback?: string;
}

export interface OutboundCallResult {
  success: boolean;
  /** Internal call ID (for tracking before Twilio responds) */
  callId: string;
  /** Twilio's Call SID (only on success) */
  twilioCallSid?: string;
  /** Phone number called */
  to: string;
  /** Phone number called from */
  from: string;
  /** WebSocket stream URL */
  streamUrl: string;
  /** Error message (only on failure) */
  error?: string;
  /** Full Twilio error response (only on failure) */
  twilioError?: unknown;
}

/**
 * Initiate an outbound call that connects to a voice agent via WebSocket.
 * 
 * This handles the full flow:
 * 1. Generate unique call ID
 * 2. Build WebSocket stream URL
 * 3. Generate TwiML with media stream
 * 4. Call Twilio API to initiate the call
 * 
 * @example
 * ```typescript
 * const result = await initiateOutboundCall({
 *   twilio: { accountSid, authToken, phoneNumber },
 *   to: '+15551234567',
 *   hostUrl: 'myapp.workers.dev',
 *   agentPath: '/agents/my-phone-agent',
 *   customParameters: { mode: 'outbound', campaign: 'q1-2024' },
 * });
 * 
 * if (result.success) {
 *   console.log(`Call initiated: ${result.twilioCallSid}`);
 * }
 * ```
 */
export async function initiateOutboundCall(
  config: OutboundCallConfig
): Promise<OutboundCallResult> {
  const callId = config.instanceId || `outbound-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const from = config.from || config.twilio.phoneNumber;

  if (!from) {
    return {
      success: false,
      callId,
      to: config.to,
      from: '',
      streamUrl: '',
      error: 'No from phone number configured',
    };
  }

  // Build WebSocket stream URL
  const instanceId = encodeURIComponent(callId);
  const streamUrl = `wss://${config.hostUrl}${config.agentPath}/${instanceId}/media-stream`;

  // Build custom parameters - always include callId and direction
  const customParameters: Record<string, string> = {
    callId,
    direction: 'outbound',
    callerPhone: config.to, // For outbound, the "caller" is who we're calling
    ...config.customParameters,
  };

  // Generate TwiML
  const twiml = mediaStreamTwiml(streamUrl, {
    statusCallback: config.statusCallbackUrl,
    record: config.record,
    customParameters,
  });

  // Build Twilio API request
  const url = `https://api.twilio.com/2010-04-01/Accounts/${config.twilio.accountSid}/Calls.json`;
  
  const params = new URLSearchParams({
    To: config.to,
    From: from,
    Twiml: twiml,
  });

  // AMD options
  if (config.machineDetection) {
    params.set('MachineDetection', config.machineDetection);
    if (config.machineDetectionTimeout) {
      params.set('MachineDetectionTimeout', String(config.machineDetectionTimeout));
    }
    if (config.asyncAmdStatusCallback) {
      params.set('AsyncAmdStatusCallback', config.asyncAmdStatusCallback);
      params.set('AsyncAmd', 'true');
    }
  }

  try {
    console.log(`[Outbound] Initiating call to ${config.to} from ${from}`);
    console.log(`[Outbound] Stream URL: ${streamUrl}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${btoa(`${config.twilio.accountSid}:${config.twilio.authToken}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    const responseData = await response.json();

    if (!response.ok) {
      console.error(`[Outbound] Twilio error (${response.status}):`, responseData);
      return {
        success: false,
        callId,
        to: config.to,
        from,
        streamUrl,
        error: `Twilio API error: ${response.status}`,
        twilioError: responseData,
      };
    }

    const twilioCallSid = (responseData as { sid: string }).sid;
    console.log(`[Outbound] Call initiated: ${twilioCallSid}`);

    return {
      success: true,
      callId,
      twilioCallSid,
      to: config.to,
      from,
      streamUrl,
    };
  } catch (e) {
    console.error('[Outbound] Error initiating call:', e);
    return {
      success: false,
      callId,
      to: config.to,
      from,
      streamUrl,
      error: String(e),
    };
  }
}
