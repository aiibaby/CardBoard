require('dotenv').config()
const fs = require('fs')
const accounts = `./database/accounts.json`

const { Client } = require('pg')
const { Pool } = require('pg')

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: true
})

/* Function to run query */
const run_query = async (query, param) => {
  const client = await pool.connect()
  try {
    const res = await client.query(query, param)
    return res
  } finally {
    client.release()
  }
}


/* Adds user to database */
const addUser = async (username, password) => {
  return await run_query('INSERT INTO users (username, password) VALUES ($1, $2)', [username, password])
}


/* Checks if username exists in the database.
** Return true if username is not in use, and return false if username is already used*/
const validateUsername = async (username) => {
  const match = await run_query('SELECT username FROM users WHERE username = $1', [username])
  if (match.rows.length === 0) {
    return true
  } else {
    return false
  }
}


/* Returns user object with matching username */
const retrieveUser = async (username) => {
  const match = await run_query('SELECT * FROM users WHERE username = $1', [username])
  if (match.rows.length != 0) {
    return match.rows[0]
  } else {
    return { username: undefined, password: undefined }
  }
}

/* Creates category, and locks user's categories during query.*/
const create_category = async (username, title) => {

  const queryLock = `
  SELECT category_index
  FROM category
  WHERE username = $1
  FOR UPDATE`

  const query = `
  INSERT INTO category (username, category_title, category_index)
    VALUES ($1, $2, (
      SELECT CASE
        WHEN MAX(category_index) ISNULL then 0
        ELSE MAX(category_index) + 1
      END
      FROM category
      WHERE username = $3
    ))
  RETURNING *`

  const client = await pool.connect()

  try {
    await client.query('BEGIN')
    //BEGIN TRANSACTION
    await client.query(queryLock, [username]) // LOCK
    var newCategory = await client.query(query, [username, title, username])

    //END TRANSACTION
    await client.query(`COMMIT`)
  } catch (e) {
    await client.query(`ROLLBACK`)
    throw e
  } finally {
    await client.release()
  }

  return newCategory
}

/**
 * Checks if category belongs to user,
 * then creates a card in that category
 * @param {string} username
 * @param {number} category_id
 * @param {string} card_front
 * @param {string} card_back
 */
const create_card = async (username, category_id, card_front, card_back) => {
  const query = `
    INSERT INTO card (category_id, card_front, card_back, card_index)
    VALUES ($1, $2, $3, (
      SELECT CASE
        WHEN MAX(card_index) ISNULL then 0
        ELSE MAX(card_index) + 1
      END
      FROM card
      WHERE category_id = $4
    ))
    RETURNING *`

  const validateQuery = `
    SELECT * FROM category
    WHERE username = $1 AND category_id = $2
    FOR UPDATE`

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    //BEGIN TRANSACTION
    const validation = await client.query(validateQuery, [username, category_id]) // Also locks category
    if (validation.rows[0]) {
      var new_card = await client.query(query, [category_id, card_front, card_back, category_id])
    } else {
      throw `Category does not belong to user`
    }

    //END TRANSACTION
    await client.query(`COMMIT`)
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    await client.release()
  }

  return new_card
}


/* Returns categories with matching user */
const retrieve_categories = async (username) => {
  return await run_query('SELECT * from category WHERE username = $1 ORDER BY category_index', [username])
}

/* Returns cards with matching user */
const retrieve_cards = async (username) => {
  return await run_query(`SELECT * from card WHERE category_id in (SELECT category_id FROM category WHERE username = $1) ORDER BY card_index`, [username])
}


/**
 * Deletes a category.
 * Uses multiple queries in one transaction to prevent index from messing up
 * @param {string} username
 * @param {number} id
 */
const delete_category = async (username, id) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT * from category WHERE username = $1 FOR UPDATE", [username])
    const deleted = await client.query("DELETE from category WHERE username = $1 and category_id = $2 RETURNING category_index", [username, id])
    if (deleted.rows[0]) {
      await client.query(`UPDATE category SET category_index = category_index - 1 WHERE category_index > $1 and username = $2`, [deleted.rows[0].category_index, username])
    } else {
      throw `Error: Failed to delete category. No category with matching ID and username!`
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    await client.release()
  }
  return

}

/* Edits text on a category */
const edit_category = async (username, id, text) => {
  const category = await run_query('UPDATE category SET category_title = $1 WHERE category_id = $2 AND username = $3 RETURNING *', [text, id, username])
  if (category.rows[0]) {
    return category.rows[0]
  } else {
    throw "Error: Failed to edit category. No category with matching ID and username!"
  }
}



/**
 * Edits the text on a card.
 * @param {string} username
 * @param {number} id
 * @param {string} text
 * @param {"front", "back"} side
 */
const edit_card = async (username, id, text, side) => {
  if (side == "front") {
    var card = await run_query('UPDATE card SET card_front = $1 WHERE card_id = $2 AND category_id in (SELECT category_id FROM category WHERE username = $3) RETURNING *', [text, id, username])
  } else if (side == "back") {
    var card = await run_query('UPDATE card SET card_back = $1 WHERE card_id = $2 AND category_id in (SELECT category_id FROM category WHERE username = $3) RETURNING *', [text, id, username])
  } else {
    throw "Error: Invalid side"
  }
  if (card.rows[0]) {
    //console.log(card.rows[0])
    return card.rows[0]
  } else {
    throw "Error: Failed to edit card. Card does not exist or card does not belong to user"
  }
}

const move_category = async (username, id, newpos) => {
  const queryLock = `
  SELECT category_index
  FROM category
  WHERE username = $1
  FOR UPDATE`

  const queryIndex = `
  SELECT MAX(category_index)
  FROM category
  WHERE username = $1`

  const queryPos = `SELECT category_index from category WHERE category_id = $1`

  const queryShiftUp = `
  UPDATE category
  SET category_index = category_index + 1
  WHERE category_index >= $1 AND category_index <= $2`

  const queryShiftDown = `
  UPDATE category
  SET category_index = category_index - 1
  WHERE category_index =< $1 AND category_index > $2`

  const queryMove = `
  UPDATE category
  SET category_index = $1
  WHERE category_id = $2
  returning *`

  const client = await pool.connect()

  try {
    await client.query('BEGIN')
    //BEGIN TRANSACTION
    await client.query(queryLock, [username])
    index = await client.query(queryIndex, [username])
    console.log(newpos)
    if (index.rows[0].max > newpos) {
      const pos = await client.query(queryPos, [id])

      if (pos.rows[0].category_index < newpos) {
        console.log(`shiftDown`)
        await client.query(queryShiftDown, [newpos, pos.rows[0].category_index])
        var moved = await client.query(queryMove, [newpos, id])
      } else {
        console.log(`shiftUp`)
        await client.query(queryShiftUp, [newpos, pos.rows[0].category_index])
        var moved = await client.query(queryMove, [newpos, id])
      }

    } else {
      throw "Index invalid"
    }
    //END TRANSACTION
    await client.query(`COMMIT`)
    console.log(moved)
  } catch (e) {
    await client.query(`ROLLBACK`)
    throw e
  } finally {
    await client.release()
  }
}

const delete_card = async (username, id) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT * from card WHERE category_id in (SELECT category_id from category WHERE username = $1) FOR UPDATE", [username])
    const deleted = await client.query("DELETE from card WHERE card_id = $1 and category_id in (SELECT category_id from category WHERE username = $2) RETURNING *", [id, username])
    if (deleted.rows[0]) {
      await client.query(`UPDATE card SET card_index = card_index - 1 WHERE card_index > $1`, [deleted.rows[0].card_index])
    } else {
      throw `Error: Failed to delete card. No category with matching ID and username!`
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    await client.release()
  }
  return

}

run_query(`SELECT * from category WHERE username = 'jason' ORDER BY category_index`).then(res => console.log(res.rows))
//run_query(`SELECT * from card`).then(res => console.log(res.rows))
module.exports = {
  addUser,
  validateUsername,
  retrieveUser,
  run_query,
  retrieve_categories,
  retrieve_cards,
  create_category,
  delete_category,
  create_card,
  edit_card,
  edit_category,
  delete_card
}

