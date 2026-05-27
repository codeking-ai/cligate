import agentChannelRegistry from './registry.js';
import agentChannelDeliveryStore from './delivery-store.js';
import stateCoordinator from '../assistant-core/domain/state-coordinator.js';
import artifactService from '../assistant-core/artifact-service.js';

function normalizeOutboundImages(message = {}, payload = {}, artifactServiceInstance = artifactService) {
  const explicitImages = Array.isArray(message?.images)
    ? message.images.filter((entry) => entry && typeof entry === 'object')
    : [];
  if (explicitImages.length > 0) {
    return explicitImages;
  }

  const artifactRefs = Array.isArray(payload?.artifactRefs)
    ? payload.artifactRefs.map((entry) => String(entry || '').trim()).filter(Boolean)
    : [];
  const images = artifactRefs
    .map((artifactId) => artifactServiceInstance.getArtifact?.(artifactId) || null)
    .filter(Boolean)
    .map((artifact) => ({
      imageUrl: String(artifact.imageUrl || '').trim(),
      mediaType: String(artifact.mediaType || '').trim(),
      title: String(artifact.title || '').trim(),
      artifactId: String(artifact.id || '').trim(),
      path: String(artifact.path || '').trim()
    }))
    .filter((entry) => entry.imageUrl || entry.path);
  return images;
}

export class AgentChannelDeliverySender {
  constructor({
    registry = agentChannelRegistry,
    deliveryStore = agentChannelDeliveryStore,
    stateCoordinator: stateCoordinatorArg = stateCoordinator,
    artifactService: artifactServiceArg = artifactService
  } = {}) {
    this.registry = registry;
    this.deliveryStore = deliveryStore;
    this.stateCoordinator = stateCoordinatorArg;
    this.artifactService = artifactServiceArg;
  }

  setRegistry(registry) {
    this.registry = registry || this.registry;
  }

  setDeliveryStore(deliveryStore) {
    this.deliveryStore = deliveryStore || this.deliveryStore;
  }

  setStateCoordinator(stateCoordinatorArg) {
    this.stateCoordinator = stateCoordinatorArg || this.stateCoordinator;
  }

  async send({
    conversation,
    channel,
    sessionId = null,
    eventSeq = null,
    payload = {},
    message = {}
  } = {}) {
    const provider = this.registry.get(conversation?.channel || channel, conversation?.accountId);
    if (!provider?.sendMessage) {
      return null;
    }

    const outboundText = String(message?.text || payload?.fullText || payload?.text || '').trim();
    const outboundImages = normalizeOutboundImages(message, payload, this.artifactService);
    if (!outboundText && outboundImages.length === 0) {
      return null;
    }

    const result = await provider.sendMessage({
      conversation,
      text: outboundText,
      images: outboundImages,
      buttons: Array.isArray(message?.buttons) ? message.buttons : [],
      session: message?.session || null,
      event: message?.event || null
    });

    const delivery = this.deliveryStore.saveOutbound({
      channel: conversation?.channel || channel,
      conversationId: conversation?.id,
      sessionId,
      eventSeq,
      externalMessageId: result?.messageId || '',
      status: 'sent',
      payload: {
        ...payload,
        fullText: outboundText,
        ...(outboundImages.length > 0 ? { images: outboundImages, artifactRefs: Array.isArray(payload?.artifactRefs) ? payload.artifactRefs : outboundImages.map((entry) => entry.artifactId).filter(Boolean) } : {})
      }
    });
    this.stateCoordinator?.recordDeliveryEpisode?.({
      delivery,
      conversationId: conversation?.id,
      runtimeSessionId: sessionId,
      metadata: {
        source: 'agent_channel_delivery_sender'
      }
    });

    return result;
  }

  suppress({
    conversation,
    channel,
    sessionId = null,
    eventSeq = null,
    payload = {},
    reason = ''
  } = {}) {
    const delivery = this.deliveryStore.saveOutbound({
      channel: conversation?.channel || channel,
      conversationId: conversation?.id,
      sessionId,
      eventSeq,
      status: 'suppressed',
      payload: {
        ...payload,
        suppressionReason: String(reason || '').trim()
      }
    });
    this.stateCoordinator?.recordDeliveryEpisode?.({
      delivery,
      conversationId: conversation?.id,
      runtimeSessionId: sessionId,
      metadata: {
        source: 'agent_channel_delivery_sender'
      }
    });
    return delivery;
  }
}

export const agentChannelDeliverySender = new AgentChannelDeliverySender();

export default agentChannelDeliverySender;
