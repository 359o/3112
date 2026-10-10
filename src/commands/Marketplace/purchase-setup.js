import {
  SlashCommandBuilder,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  AttachmentBuilder,
} from 'discord.js';

// Auto-detect import paths so it never fails whether inside src/commands/ or src/commands/Marketplace/
let marketplaceService, interactionHelperModule, errorHandlerModule, loggerModule;
try {
  marketplaceService = await import('../../services/marketplaceService.js');
  interactionHelperModule = await import('../../utils/interactionHelper.js');
  errorHandlerModule = await import('../../utils/errorHandler.js');
  loggerModule = await import('../../utils/logger.js');
} catch {
  marketplaceService = await import('../services/marketplaceService.js');
  interactionHelperModule = await import('../utils/interactionHelper.js');
  errorHandlerModule = await import('../utils/errorHandler.js');
  loggerModule = await import('../utils/logger.js');
}

const { isPackSeller, saveListing } = marketplaceService;
const { InteractionHelper } = interactionHelperModule;
const { replyUserError, ErrorTypes } = errorHandlerModule;
const { logger } = loggerModule;

// Category ID for "pack seller ticket"
const PACK_SELLER_CATEGORY_ID = '1558316273350221944';

export default {
  data: new SlashCommandBuilder()
    .setName('purchase-setup')
    .setDescription('Create and post a new product selling listing (Pack Sellers only)')
    .addAttachmentOption((option) =>
      option
        .setName('video')
        .setDescription('Upload the product showcase video')
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName('title')
        .setDescription('The title or name of the pack/product (e.g. Chrome Havoc)')
        .setRequired(true)
        .setMaxLength(100)
    )
    .addStringOption((option) =>
      option
        .setName('price')
        .setDescription('The price of the item (e.g. $13)')
        .setRequired(false)
        .setMaxLength(50)
    )
    .addStringOption((option) =>
      option
        .setName('description')
        .setDescription('Optional extra details or description')
        .setRequired(false)
        .setMaxLength(500)
    )
    .addAttachmentOption((option) =>
      option
        .setName('product_file')
        .setDescription('Upload the product file (.zip, .rar, etc.) to deliver to buyers')
        .setRequired(false)
    )
    .addStringOption((option) =>
      option
        .setName('product_link')
        .setDescription('Or paste a Google Drive / Mega download link for large files')
        .setRequired(false)
    )
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('The channel to post the listing in (defaults to current channel)')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false)
    ),

  category: 'Marketplace',

  async execute(interaction, guildConfig, client) {
    const deferred = await InteractionHelper.safeDefer(interaction, {
      flags: MessageFlags.Ephemeral,
    });
    if (!deferred) return;

    // Check seller permissions: must have Pack Seller role or Admin
    if (!isPackSeller(interaction.member)) {
      return await replyUserError(interaction, {
        type: ErrorTypes.PERMISSION,
        message: '❌ You must have the **Pack Seller** role to create marketplace listings.',
      });
    }

    const videoAttachment = interaction.options.getAttachment('video');
    const title = interaction.options.getString('title').trim();
    const rawPrice = interaction.options.getString('price')?.trim();
    const description = interaction.options.getString('description')?.trim();
    const productFile = interaction.options.getAttachment('product_file');
    const productLink = interaction.options.getString('product_link')?.trim();
    const targetChannel =
      interaction.options.getChannel('channel') || interaction.channel;

    // Validate that the attachment is a video
    const isVideo =
      videoAttachment?.contentType?.startsWith('video/') ||
      /\.(mp4|mov|webm|mkv|avi)$/i.test(videoAttachment?.name || '');

    if (!isVideo) {
      return await replyUserError(interaction, {
        type: ErrorTypes.VALIDATION,
        message: '❌ The uploaded file must be a valid video file (.mp4, .mov, .webm, etc.).',
      });
    }

    // Format price if provided
    let formattedPrice = null;
    if (rawPrice) {
      formattedPrice = rawPrice.startsWith('$') ? rawPrice : `$${rawPrice}`;
    }

    // Generate unique listing identifier
    const uniqueSuffix = Math.random().toString(36).substring(2, 7);
    const listingId = `pack_${Date.now().toString(36)}_${uniqueSuffix}`;

    // Clean text format (Exact Chrome Havoc style - NO embed box, NO green bar!)
    let messageContent = `**${title}**\n`;
    if (formattedPrice) {
      messageContent += `Price: ${formattedPrice}\n`;
    }
    if (description) {
      messageContent += `${description}\n`;
    }
    messageContent += `Seller: <@${interaction.user.id}>`;

    // Attached video file (renders native playable video player)
    const videoFile = new AttachmentBuilder(videoAttachment.url, {
      name: videoAttachment.name || 'product_showcase.mp4',
    });

    // Green Purchase Button underneath the video
    const purchaseRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`purchase_buy:${listingId}`)
        .setLabel('Purchase')
        .setStyle(ButtonStyle.Success)
        .setEmoji('🛒')
    );

    try {
      // Send with NO embeds so Discord expands the video into full player
      const sentMessage = await targetChannel.send({
        content: messageContent,
        files: [videoFile],
        components: [purchaseRow],
      });

      // Save listing to persistent database with product delivery data
      const listingData = {
        id: listingId,
        guildId: interaction.guildId,
        channelId: targetChannel.id,
        ticketCategoryId: PACK_SELLER_CATEGORY_ID,
        messageId: sentMessage.id,
        messageUrl: sentMessage.url,
        sellerId: interaction.user.id,
        sellerTag: interaction.user.tag,
        title,
        price: formattedPrice,
        description: description || null,
        videoUrl: videoAttachment.url,
        productFileUrl: productFile?.url || null,
        productFileName: productFile?.name || null,
        productLink: productLink || null,
        status: 'active',
        createdAt: new Date().toISOString(),
      };

      await saveListing(interaction.guildId, listingData);

      logger.info(`Posted marketplace listing ${listingId} in #${targetChannel.name} by ${interaction.user.tag}`);

      return await interaction.editReply({
        content: `✅ Successfully created your listing for **${title}** in <#${targetChannel.id}>!\n🔗 [Jump to Listing](${sentMessage.url})\n📦 **Product Delivery:** ${productFile ? `File (${productFile.name}) attached` : productLink ? `Link configured` : 'Manual delivery in ticket'}`,
      });
    } catch (error) {
      logger.error('Failed to post marketplace listing message:', error);
      return await replyUserError(interaction, {
        type: ErrorTypes.UNKNOWN,
        message: `Failed to post listing in <#${targetChannel.id}>: ${error.message}. Please check bot channel permissions.`,
      });
    }
  },
};
