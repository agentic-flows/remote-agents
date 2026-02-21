export {
  // Config
  type TwilioConfig,
  
  // Result types
  type TwilioCallResult,
  type TerminateCallResult,
  type ConferenceResult,
  type ParticipantResult,
  type OutboundCallConfig,
  type OutboundCallResult,
  
  // Call control
  terminateCall,
  updateCall,
  createCall,
  createOutboundCallWithUrl,
  
  // Outbound call orchestration
  initiateOutboundCall,
  
  // Conference operations
  getConference,
  addParticipantToConference,
  updateParticipant,
  removeParticipant,
  endConference,
  
  // TwiML builders
  conferenceWithHoldTwiml,
  conferenceJoinTwiml,
  dialTwiml,
  voicemailTwiml,
  mediaStreamTwiml,
} from './client';
