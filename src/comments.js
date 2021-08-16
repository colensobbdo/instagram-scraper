const Apify = require('apify');
const Puppeteer = require('puppeteer'); // eslint-disable-line no-unused-vars
const { getCheckedVariable, log, filterPushedItemsAndUpdateState, finiteScroll } = require('./helpers');
const { PAGE_TYPES } = require('./consts');
const errors = require('./errors');

const { sleep } = Apify.utils;

const initData = {};

/**
 * Takes type of page and data loaded through GraphQL and outputs
 * correct list of comments.
 * @param {Object} data GraphQL data
 */
const getCommentsFromGraphQL = ({ data }) => {
    let shortcode_media;
    // TODO remove this garbage :)
    if (data.data) {
        // log(itemSpec, 'HAD NESTED DATA', LOG_TYPES.WARNING);
        shortcode_media = data.data.shortcode_media;
    } else {
        shortcode_media = data.shortcode_media;
    }
    const timeline = shortcode_media && shortcode_media.edge_media_to_parent_comment;
    const commentItems = timeline ? timeline.edges.reverse() : [];
    const commentsCount = timeline ? timeline.count : null;
    const hasNextPage = timeline ? timeline.page_info.has_next_page : false;
    return { comments: commentItems, hasNextPage, commentsCount };
};

/**
 * Loads data from entry date and then loads comments until limit is reached
 * @param {{
 *   page: Puppeteer.Page,
 *   itemSpec: any,
 *   entryData: any,
 *   additionalData: any,
 *   scrollingState: any,
 *   extendOutputFunction: (data: any, meta: any) => Promise<void>
 * }} params
 */
const scrapeComments = async ({ page, request, itemSpec, entryData, additionalData, scrollingState, extendOutputFunction }) => {
    // Check that current page is of a type which has comments
    if (itemSpec.pageType !== PAGE_TYPES.POST) throw errors.notPostPage();

    // Check if the page loaded properly
    try {
        await page.waitForSelector('.EtaWk', { timeout: 15000 });
    } catch (e) {
        throw new Error(`Post page didn't load properly, opening again`);
    }

    const timeline = getCommentsFromGraphQL({ data: entryData.PostPage[0].graphql || additionalData.graphql });
    initData[itemSpec.id] = timeline;

    // We want to push as soon as we have the data. We have to persist comment ids state so we don;t loose those on migration
    if (initData[itemSpec.id]) {
        const commentsReadyToPush = await filterPushedItemsAndUpdateState({
            items: timeline.comments,
            itemSpec,
            parsingFn: parseCommentsForOutput(request),
            scrollingState,
            page,
            type: 'comments',
        });
        log(page.itemSpec, `${timeline.comments.length} comments loaded, ${Object.keys(scrollingState[itemSpec.id].ids).length}/${timeline.commentsCount} comments scraped`);

        await extendOutputFunction(commentsReadyToPush, {
            label: 'comment',
            page,
        });
    } else {
        log(itemSpec, 'Waiting for initial data to load');
        while (!initData[itemSpec.id]) await sleep(100);
    }

    await sleep(1500);

    const willContinueScroll = initData[itemSpec.id].hasNextPage && Object.keys(scrollingState[itemSpec.id].ids).length < itemSpec.limit;
    if (willContinueScroll) {
        // await sleep(1000);
        await finiteScroll({
            itemSpec,
            page,
            scrollingState,
            getItemsFromGraphQLFn: getCommentsFromGraphQL,
            type: 'comments',
        });
    }
};

/**
 * Takes GraphQL response, checks that it's a response with more comments and then parses the comments from it
 * @param {{
 *   page: Puppeteer.Page,
 *   response: Puppeteer.HTTPResponse,
 *   scrollingState: any,
 *   extendOutputFunction: (data: any, meta: any) => Promise<void>,
 * }} params
 */
async function handleCommentsGraphQLResponse({ page, request, response, scrollingState, extendOutputFunction }) {
    const responseUrl = response.url();
    const { itemSpec } = page;

    // Get variable we look for in the query string of request
    const checkedVariable = getCheckedVariable(itemSpec.pageType);

    // Skip queries for other stuff then posts
    if (!responseUrl.includes(checkedVariable) || !responseUrl.includes('%22first%22')) return;

    let data;
    const status = response.status();
    if (status === 200) {
        data = await response.json();
    } else {
        // This error is also handled elsewhere and from here it is useless to log it
        return;
    }

    const timeline = getCommentsFromGraphQL({ data: data.data });

    if (!initData[itemSpec.id]) {
        initData[itemSpec.id] = timeline;
    } else if (initData[itemSpec.id].hasNextPage && !timeline.hasNextPage) {
        initData[itemSpec.id].hasNextPage = false;
    }

    const commentsReadyToPush = await filterPushedItemsAndUpdateState({
        items: timeline.comments,
        itemSpec,
        parsingFn: parseCommentsForOutput(request),
        scrollingState,
        page,
        type: 'comments',
    });

    log(itemSpec, `${timeline.comments.length} comments loaded, ${Object.keys(scrollingState[itemSpec.id].ids).length}/${timeline.commentsCount} comments scraped`);

    await extendOutputFunction(commentsReadyToPush, {
        label: 'comment',
        page,
    });
}

function parseCommentsForOutput(request) {
    return (comments, itemSpec, currentScrollingPosition) => {
        return comments.map((item, index) => ({
            '#debug': {
                index: index + currentScrollingPosition + 1,
                ...(request.userData.data || {}),
                ...Apify.utils.createRequestDebugInfo(request),
                ...itemSpec,
            },
            id: item.node.id,
            postId: itemSpec.id,
            text: item.node.text,
            position: index + currentScrollingPosition + 1,
            timestamp: new Date(parseInt(item.node.created_at, 10) * 1000),
            ownerId: item.node.owner ? item.node.owner.id : null,
            ownerIsVerified: item.node.owner ? item.node.owner.is_verified : null,
            ownerUsername: item.node.owner ? item.node.owner.username : null,
            ownerProfilePicUrl: item.node.owner ? item.node.owner.profile_pic_url : null,
        }));
    };
}

module.exports = {
    scrapeComments,
    handleCommentsGraphQLResponse,
};
