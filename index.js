require("dotenv").config()
const { NOTION_TOKEN, NOTION_DATABASE_ID } = process.env;
const { Client } = require("@notionhq/client");
const notion = new Client({ auth: NOTION_TOKEN });
const db = require("better-sqlite3")("highlights.sqlite");
const today = new Date();
const colorMapper = {
  0: "yellow_background",
  1: "pink_background",
  2: "blue_background",
  3: "green_background"
}

async function createNewEntry({ book }) {
  const title = book.Title;
  const author = book.Author;

  const response = await notion.pages.create({
    "icon": {
      "type": "emoji",
      "emoji": "📙"
    },
    "parent": {
      "type": "database_id",
      "database_id": NOTION_DATABASE_ID
    },
    "properties": {
      Title: { title: [{ text: { content: title } }] },
      Author: {
        rich_text: [{
          text: {
            content: author
          }
        }]
      },
    }
  })
  const pageId = response.id;
  console.log('created new entry for', title, response);
  exportHighlights({ book, pageId, title });
}

function chunkArray(array, chunkSize) {
  return array.reduce((accumulator, item, index) => {
    const chunkIndex = Math.floor(index / chunkSize);
    if (!accumulator[chunkIndex]) {
      accumulator[chunkIndex] = []; // Start a new chunk
    }
    accumulator[chunkIndex].push(item);
    return accumulator;
  }, []);
}

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function exportHighlights({ book, pageId, title }) {
  const highlightHeading = {
    object: "block",
    type: "heading_2",
    heading_2: {
      "rich_text": [{ text: { content: `Highlights - ${today.toLocaleDateString('en-US')}` } }],
    },
  }

  // Append heading onto page
  try {
    await notion.blocks.children.append({
      block_id: pageId,
      children: [highlightHeading],
    });
    await delay(350);
  } catch (error) {
    console.log(`Error appending header for ${title}: `, error.response || error);
  }

  // Retrieve highlights for the book
  const getHighlightsQuery =
  "SELECT Bookmark.Text, Bookmark.Color FROM Bookmark INNER JOIN content ON Bookmark.VolumeID = content.ContentID " +
  "WHERE content.ContentID = ? " +
  "ORDER BY content.DateCreated DESC";
  const highlightsList = db
    .prepare(getHighlightsQuery)
    .all(book.ContentID);
  console.log('highlightsList length', highlightsList.length, title)

  // There is a limit of 100 block children that can be appended by a single API request. Arrays of block children longer than 100 will result in an error.
  const chunkedHighlightsList = chunkArray(highlightsList, 100);

  for (const innerArray of chunkedHighlightsList) {
    try {
      // Generates a text block for each highlight
      const highlightedChildren = innerArray.map(highlight => {
        if (highlight.Text !== null) {
          return ({
            type: "bulleted_list_item",
            bulleted_list_item: {
              rich_text: [{
                "type": "text",
                "text": {
                  "content": highlight.Text,
                },
                "annotations": {
                  "color": colorMapper[highlight.Color]
                },
              }]
            }
          })
        }
      }).filter(Boolean); // This removes any null/undefined elements

      //Appends the blocks to the book page
      await notion.blocks.children.append({
        block_id: pageId,
        children: highlightedChildren,
      });
      console.log(`Appended ${innerArray.length} highlights for ${title}.`);
      await delay(350); // Delay of 350ms to avoid rate limits
    } catch (error) {
      console.log(`Error appending blocks for ${title}: `, error.response || error);
    }
  }

  try {
    await notion.pages.update({
      page_id: pageId,
      properties: { Highlights: { checkbox: true } },
    });
    console.log(`All highlights have been processed and uploaded for ${title}.`);
    await delay(350);
  } catch (error) {
    console.error(`An error occurred while processing highlights for ${title}: `, error.response || error);
  }
}

async function matchingLogic() {
  const getBookListQuery =
    "SELECT DISTINCT content.ContentId, content.Title, content.Attribution AS Author " +
    "FROM Bookmark INNER JOIN content " +
    "ON Bookmark.VolumeID = content.ContentID " +
    "ORDER BY content.Title";
  const bookList = db.prepare(getBookListQuery).all();

  for (book of bookList) {
    try {
      let title = book.Title;
      let author = book.Author;

      // Check Notion database for the book
      const bookExistResponse = await notion.databases.query({
        database_id: NOTION_DATABASE_ID,
        filter: {
          property: "Title", title: { equals: title }
        }
      })

      if (bookExistResponse.results.length > 0) {
        // if book exists, check highlight status for that book
        const notHighlightedResponse = await notion.databases.query({
          database_id: NOTION_DATABASE_ID,
          filter: {
            and: [
              { property: "Title", title: { equals: title } },
              { property: "Highlights", checkbox: { equals: false } },
            ],
          },
        });

        if (notHighlightedResponse.results.length > 0) {
          // if highlights unchecked, update entry with highlights
          const pageId = notHighlightedResponse.results[0].id;
          exportHighlights({ book, pageId, title })
        } else {
          console.log(`${title} was skipped.`);
        }
      } else {
        // DNE; add a new page
        createNewEntry({ title, author, book });
      }
    } catch (error) {
      console.log(`Error with ${book.Title}: `, error);
    }
  }
}

matchingLogic();
