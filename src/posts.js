const Apify = require('apify');
// eslint-disable-next-line no-unused-vars
const Puppeteer = require('puppeteer');
const { getCheckedVariable, log, finiteScroll, filterPushedItemsAndUpdateState, shouldContinueScrolling } = require('./helpers');
const { PAGE_TYPES, LOG_TYPES } = require('./consts');
const { formatSinglePost } = require('./details');

const { sleep } = Apify.utils;

const initData = {};

/**
 * Takes type of page and data loaded through GraphQL and outputs
 * correct list of posts based on the page type.
 * @param {{
 *   pageType: string,
 *   data: Record<string, any>
 * }} params
 */
const getPostsFromGraphQL = ({ pageType, data }) => {
    let timeline;
    switch (pageType) {
        case PAGE_TYPES.PLACE:
            timeline = data?.location?.edge_location_to_media
                ?? {
                    edges: data?.sections?.filter(({ layout_type }) => layout_type === 'media_grid')
                        .flatMap(({ layout_content }) => layout_content.medias.map(({ media }) => media)),
                };
            break;
        case PAGE_TYPES.PROFILE:
            timeline = data?.user?.edge_owner_to_timeline_media;
            break;
        case PAGE_TYPES.HASHTAG:
            timeline = data?.hashtag?.edge_hashtag_to_media
                ?? {
                    edges: data?.sections?.filter(({ layout_type }) => layout_type === 'media_grid')
                        .flatMap(({ layout_content }) => layout_content.medias.map(({ media }) => media)),
                };
            break;
        default: throw new Error('Not supported');
    }
    const postItems = timeline?.edges ?? [];
    const hasNextPage = timeline?.page_info?.has_next_page ?? false;
    const postsCount = timeline?.count ?? postItems.length;

    return {
        posts: postItems,
        hasNextPage,
        postsCount,
        needsEnqueue: data?.needsEnqueue ?? false,
    };
};

/**
 * Takes type of page and it's initial loaded data and outputs
 * correct list of posts based on the page type.
 * @param {string} pageType Type of page we are scraping posts from
 * @param {Record<string, any>} data GraphQL data
 */
const getPostsFromEntryData = (pageType, data) => {
    let pageData;
    switch (pageType) {
        case PAGE_TYPES.PLACE:
            pageData = data?.LocationsPage?.[0]?.graphql ?? { sections: [
                ...(data?.sections ?? []),
                ...(data?.LocationsPage?.[0]?.native_location_data?.ranked?.sections ?? []),
                ...(data?.LocationsPage?.[0]?.native_location_data?.recent?.sections ?? []),
            ],
            needsEnqueue: true };
            break;
        case PAGE_TYPES.PROFILE:
            pageData = data.ProfilePage[0].graphql;
            break;
        case PAGE_TYPES.HASHTAG:
            pageData = data?.TagPage?.[0]?.graphql ?? {
                sections: [
                    ...(data?.recent?.sections ?? []),
                    ...(data?.top?.sections ?? []),
                ],
                needsEnqueue: true,
            };
            break;
        default: throw new Error('Not supported');
    }

    if (!pageData) return null;

    return getPostsFromGraphQL({ pageType, data: pageData });
};

/**
 * @param {Apify.Request} request
 * @param {any} itemSpec
 * @param {any} entryData
 * @param {any} additionalData
 */
const scrapePost = (request, itemSpec, entryData, additionalData) => {
    const item = (() => {
        try {
            return entryData.PostPage[0].graphql.shortcode_media;
        } catch (e) {
            return additionalData.graphql.shortcode_media;
        }
    })();

    return {
        ...(request.userData.data || {}),
        '#debug': {
            ...Apify.utils.createRequestDebugInfo(request),
            ...itemSpec,
            shortcode: item.shortcode,
            postLocationId: (item.location && item.location.id) || null,
            postOwnerId: (item.owner && item.owner.id) || null,
        },
        alt: item.accessibility_caption,
        url: `https://www.instagram.com/p/${item.shortcode}`,
        likesCount: item.edge_media_preview_like.count,
        imageUrl: item.display_url,
        firstComment: item.edge_media_to_caption.edges[0] && item.edge_media_to_caption.edges[0].node.text,
        timestamp: new Date(parseInt(item.taken_at_timestamp, 10) * 1000),
        locationName: (item.location && item.location.name) || null,
        ownerUsername: (item.owner && item.owner.username) || null,
    };
};

/**
 * Takes data from entry data and from loaded xhr requests and parses them into final output.
 * @param {{
 *   page: Puppeteer.Page,
 *   itemSpec: any,
 *   additionalData: any,
 *   entryData: Record<string, any>,
 *   scrollingState: Record<string, any>,
 *   requestQueue: Apify.RequestQueue,
 *   extendOutputFunction: (data: any, meta: any) => Promise<void>,
 *   resultsType: string,
 *   fromResponse: boolean,
 * }} params
 */
const scrapePosts = async ({ page, request, itemSpec, requestQueue, entryData, fromResponse = false, scrollingState, extendOutputFunction, additionalData, resultsType }) => {
    const timeline = getPostsFromEntryData(itemSpec.pageType, entryData);

    if (!timeline) {
        return;
    }

    if (timeline?.needsEnqueue) {
        Apify.utils.log.debug('Needs enqueue', { url: page.url(), length: timeline.posts?.length });

        if (!timeline.posts?.length) {
            return;
        }

        scrollingState[itemSpec.id] = scrollingState[itemSpec.id] || {
            ids: {},
            allDuplicates: false,
        };

        let count = 0;

        // needs to enqueue the codes, since the location data is completely different
        for (const { code, id } of timeline.posts) {
            const rq = await requestQueue.addRequest({
                url: `https://www.instagram.com/p/${code}`,
                userData: {
                    label: 'postDetail',
                    pageType: PAGE_TYPES.POST,
                },
            });

            if (!rq.wasAlreadyPresent) {
                count++;
            }

            scrollingState[itemSpec.id].ids[id] = true;

            if (Object.keys(scrollingState[itemSpec.id].ids).length >= itemSpec.limit) {
                return;
            }
        }

        if (count > 0) {
            log(itemSpec, `Got ${count} posts`, LOG_TYPES.INFO);
        }

        if (fromResponse) {
            Apify.utils.log.debug('From response', { url: page.url() });
            return;
        }
    }

    initData[itemSpec.id] = timeline;

    // Check if the posts loaded properly
    if (itemSpec.pageType === PAGE_TYPES.PROFILE) {
        const profilePageSel = '.ySN3v';

        try {
            await page.waitForSelector(`${profilePageSel}`, { timeout: 5000 });
        } catch (e) {
            log(itemSpec, 'Profile page didn\'t load properly, trying again...', LOG_TYPES.ERROR);
            throw new Error('Profile page didn\'t load properly, trying again...');
        }

        const privatePageSel = '.rkEop';
        const elPrivate = await page.$(`${privatePageSel}`);
        if (elPrivate) {
            log(itemSpec, 'Profile is private exiting..', LOG_TYPES.ERROR);
            return;
        }
    }

    if (itemSpec.pageType === PAGE_TYPES.PLACE || itemSpec.pageType === PAGE_TYPES.HASHTAG) {
        try {
            await page.waitForSelector('.EZdmt', { timeout: 25000 });
        } catch (e) {
            log(itemSpec, 'Place/location or hashtag page didn\'t load properly, trying again...', LOG_TYPES.ERROR);
            throw new Error('Place/location or hashtag page didn\'t load properly, trying again...');
        }
    }

    if (!timeline.needsEnqueue) {
        if (initData[itemSpec.id]) {
            const postsReadyToPush = await filterPushedItemsAndUpdateState({
                items: timeline.posts,
                itemSpec,
                parsingFn: parsePostsForOutput(request),
                scrollingState,
                type: 'posts',
                page,
            });
            // We save last date for the option to specify how far into the past we should scroll
            if (postsReadyToPush.length > 0) {
                scrollingState[itemSpec.id].lastPostDate = postsReadyToPush[postsReadyToPush.length - 1].timestamp;
            }

            log(itemSpec, `${timeline.posts.length} posts loaded, ${Object.keys(scrollingState[itemSpec.id].ids).length}/${timeline.postsCount} posts scraped`);
            await extendOutputFunction(postsReadyToPush, {
                label: 'post',
                page,
            });
        } else {
            log(itemSpec, 'Waiting for initial data to load');
            while (!initData[itemSpec.id]) await sleep(100);
        }
    }

    if (!fromResponse) {
        // this is not coming from the main page initial data
        await sleep(500);

        const hasMostRecentPostsOnHashtagPage = itemSpec.pageType === PAGE_TYPES.HASHTAG
            ? await page.evaluate(() => document.querySelector('article > h2') !== null
            && document.querySelector('article > h2').textContent === 'Most recent')
            : true;

        // Places/locations don't allow scrolling without login
        const isUnloggedPlace = itemSpec.pageType === PAGE_TYPES.PLACE && !itemSpec.input.loginCookies;
        if (isUnloggedPlace) {
            log(itemSpec, 'Place/location pages allow scrolling only under login, collecting initial posts and finishing', LOG_TYPES.WARNING);
            return;
        }

        if (timeline.needsEnqueue) {
            log(itemSpec, 'Scrolling until the end', LOG_TYPES.INFO);

            while (true) { // eslint-disable-line no-constant-condition
                if (Object.keys(scrollingState[itemSpec.id].ids).length >= itemSpec.limit) {
                    return;
                }

                await page.evaluate(() => {
                    window.scrollTo({ top: document.body.scrollHeight });
                });

                await sleep(itemSpec.scrollWaitSecs || 3000);

                await page.evaluate(() => {
                    window.scrollTo({ top: document.body.scrollHeight * 0.70 });
                });
            }
        } else {
            const hasNextPage = initData[itemSpec.id].hasNextPage && hasMostRecentPostsOnHashtagPage;
            if (hasNextPage) {
                const shouldContinue = shouldContinueScrolling({ itemSpec, scrollingState, oldItemCount: 0, type: 'posts' });
                if (shouldContinue) {
                    await sleep(1000);
                    await finiteScroll({
                        itemSpec,
                        page,
                        scrollingState,
                        getItemsFromGraphQLFn: getPostsFromGraphQL,
                        type: 'posts',
                    });
                }
            }
            // We have to forcefully close the browser here because it hangs sometimes for some listeners reasons
            // Because we always have max one page per browser, this is fine
            // console.log(`Puppeteer retire posts.js line 176`);
        }
    }
};

/**
 * Catches GraphQL responses and if they contain post data, it stores the data
 * to the global variable.
 * @param {{
 *   page: Puppeteer.Page,
 *   response: Puppeteer.HTTPResponse,
 *   scrollingState: any,
 *   extendOutputFunction: (data: any, meta: any) => Promise<void>,
 * }} params
 */
async function handlePostsGraphQLResponse({ page, request, response, scrollingState, extendOutputFunction }) {
    const responseUrl = response.url();

    const { itemSpec } = page;

    // Get variable we look for in the query string of request
    const checkedVariable = getCheckedVariable(itemSpec.pageType);

    // Skip queries for other stuff then posts
    if (!responseUrl.includes(checkedVariable) || !responseUrl.includes('%22first%22')) return;

    // If it fails here, it means that the error was caught in the finite scroll anyway so we just don't do anything
    let data;
    try {
        data = await response.json();
    } catch (e) {
        return;
    }
    const timeline = getPostsFromGraphQL({ pageType: itemSpec.pageType, data: data.data });

    if (!initData[itemSpec.id]) initData[itemSpec.id] = timeline;
    else if (initData[itemSpec.id].hasNextPage && !timeline.hasNextPage) {
        initData[itemSpec.id].hasNextPage = false;
    }

    const postsReadyToPush = await filterPushedItemsAndUpdateState({
        items: timeline.posts,
        itemSpec,
        parsingFn: parsePostsForOutput(request),
        scrollingState,
        type: 'posts',
        page,
    });
    // We save last date for the option to specify how far into the past we should scroll
    if (postsReadyToPush.length > 0) {
        scrollingState[itemSpec.id].lastPostDate = postsReadyToPush[postsReadyToPush.length - 1].timestamp;
    }

    log(itemSpec, `${timeline.posts.length} posts loaded, ${Object.keys(scrollingState[itemSpec.id].ids).length}/${timeline.postsCount} posts scraped`);
    await extendOutputFunction(postsReadyToPush, {
        label: 'post',
        page,
    });
}

function parsePostsForOutput(request) {
    return (posts, itemSpec, currentScrollingPosition) => {
        return posts.map((item, index) => ({
            ...(request.userData.data || {}),
            '#debug': {
                ...itemSpec,
                shortcode:
                    item?.node?.shortcode
                    ?? item?.code,
                postLocationId: item?.node?.location?.id
                    ?? item?.location?.pk
                    ?? null,
                postOwnerId: item?.node?.owner?.id
                    ?? item?.user?.pk
                    ?? null,
            },
            queryTag: itemSpec.tagName,
            queryUsername: itemSpec.userUsername,
            queryLocation: itemSpec.locationName,
            position: currentScrollingPosition + 1 + index,
            ...formatSinglePost(item.node),
        }));
    };
}

/**
 * Add a post
 *
 * @param {Apify.RequestQueue} requestQueue
 */
const createAddPost = (requestQueue) => {
    /**
     * @param {string} code
     */
    return async (code) => {
        const url = new URL(code, 'https://www.instagram.com/p/');

        return requestQueue.addRequest({
            url: url.toString(),
            userData: {
                pageType: PAGE_TYPES.POST,
            },
        });
    };
};

module.exports = {
    scrapePost,
    scrapePosts,
    createAddPost,
    handlePostsGraphQLResponse,
};
