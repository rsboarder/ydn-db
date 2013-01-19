/**
 * @fileoverview Cursor.
 */


goog.provide('ydn.db.index.req.WebsqlCursor');
goog.require('ydn.db.index.req.AbstractCursor');


/**
 * Open an index. This will resume depending on the cursor state.
 * @param {SQLTransaction} tx object store.
 * @param {!ydn.db.schema.Store} store_schema schema.
 * @param {string} store_name the store name to open.
 * @param {string|undefined} index_name index
 * @param {IDBKeyRange} keyRange
 * @param {ydn.db.base.Direction} direction we are using old spec
 * @param {boolean} key_only mode.
 * @param {*=} ini_key primary key to resume position.
 * @param {*=} ini_index_key index key to resume position.
 * @extends {ydn.db.index.req.AbstractCursor}
 * @constructor
 */
ydn.db.index.req.WebsqlCursor = function(tx, store_schema, store_name,
    index_name, keyRange, direction, key_only, ini_key, ini_index_key) {

  goog.base(this, store_name, index_name, keyRange, direction, key_only);

  goog.asserts.assert(tx);
  this.tx = tx;

  goog.asserts.assert(store_schema);
  this.store_schema_ = store_schema;

  this.cursor_ = null;
  this.current_cursor_index_ = NaN;

  //this.open_request(ini_key, ini_index_key);
};
goog.inherits(ydn.db.index.req.WebsqlCursor, ydn.db.index.req.AbstractCursor);


/**
 * @define {boolean}
 */
ydn.db.index.req.WebsqlCursor.DEBUG = false;


/**
 * @protected
 * @type {goog.debug.Logger} logger.
 */
ydn.db.index.req.WebsqlCursor.prototype.logger =
  goog.debug.Logger.getLogger('ydn.db.index.req.WebsqlCursor');


/**
 * @private
 * @type {SQLTransaction}
 */
ydn.db.index.req.WebsqlCursor.prototype.tx;


/**
 *
 * @type {!ydn.db.schema.Store}
 * @private
 */
ydn.db.index.req.WebsqlCursor.prototype.store_schema_;


/**
 * 
 * @type {*}
 * @private
 */
ydn.db.index.req.WebsqlCursor.prototype.current_key_ = null;

/**
 *
 * @type {*}
 * @private
 */
ydn.db.index.req.WebsqlCursor.prototype.current_primary_key_ = null;

/**
 *
 * @type {*}
 * @private
 */
ydn.db.index.req.WebsqlCursor.prototype.current_value_ = null;


/**
 * @type {SQLResultSet}
 * @private
 */
ydn.db.index.req.WebsqlCursor.prototype.cursor_ = null;

/**
 *
 * @type {number}
 * @private
 */
ydn.db.index.req.WebsqlCursor.prototype.current_cursor_index_ = NaN;


/**
 * Move cursor to next position.
 * @return {Array} [primary_key, effective_key, reference_value]
 * @private
 */
ydn.db.index.req.WebsqlCursor.prototype.moveNext_ = function() {

  this.current_cursor_index_++;

  return [this.getPrimaryKey(), this.getIndexKey(), this.getValue()];
};

/**
 * Invoke onSuccess handler with next cursor value.
 */
ydn.db.index.req.WebsqlCursor.prototype.invokeNextSuccess_ = function() {

  var current_values = this.moveNext_();

  if (ydn.db.index.req.WebsqlCursor.DEBUG) {
    window.console.log(['onSuccess', this.current_cursor_index_].concat(current_values));
  }

  var primary_key = current_values[0];
  var index_key = current_values[1];
  var value = current_values[2];
  this.onSuccess(primary_key, index_key, value);

};


/**
 * Make cursor opening request.
 *
 * This will seek to given initial position if given. If only ini_key (primary
 * key) is given, this will rewind, if not found.
 *
 * @param {*=} ini_key primary key to resume position.
 * @param {*=} ini_index_key index key to resume position.
 * @param {boolean=} exclusive
 * @private
 */
ydn.db.index.req.WebsqlCursor.prototype.open_request = function(ini_key, ini_index_key, exclusive) {

  var label = this.store_name + ':' + this.index_name;

  var key_range = this.key_range;
  if (!!this.index_name && goog.isDefAndNotNull(ini_index_key)) {
    if (goog.isDefAndNotNull(this.key_range)) {
    var cmp = ydn.db.con.IndexedDb.indexedDb.cmp(ini_index_key, this.key_range.upper);
    if (cmp == 1 || (cmp == 0 && !this.key_range.upperOpen)) {
      this.onNext(undefined, undefined, undefined); // out of range;
      return;
    }
    key_range = ydn.db.IDBKeyRange.bound(ini_index_key,
      this.key_range.upper, false, this.key_range.upperOpen);
    } else {
      key_range = ydn.db.IDBKeyRange.lowerBound(ini_index_key);
    }
  }

  /**
   * @type {ydn.db.index.req.WebsqlCursor}
   */
  var me = this;
  var request;
  var sqls = ['SELECT'];
  var params = [];
  var primary_column_name = this.store_schema_.getColumnName();
  var column_name = this.index_name ?
      this.index_name : primary_column_name;
  var q_column_name = goog.string.quote(column_name);
  var q_primary_column_name = goog.string.quote(primary_column_name);
  sqls.push(this.key_only ?
    q_column_name + ', ' + q_primary_column_name : '*');
  sqls.push('FROM ' + goog.string.quote(this.store_name));

  var where_clause = ydn.db.Where.toWhereClause(column_name, key_range);
  if (where_clause.sql) {
    sqls.push('WHERE ' + where_clause.sql);
    params = params.concat(where_clause.params);
  }

//  if (goog.isDefAndNotNull(ini_key)) {
//    if (where_clause.sql) {
//      sqls.push('AND ' + ydn.db.base.SQLITE_SPECIAL_COLUNM_NAME + ' = ?');
//      params.push(ini_key);
//    } else {
//      sqls.push('WHERE ' + ydn.db.base.SQLITE_SPECIAL_COLUNM_NAME + ' = ?');
//      params.push(ini_key);
//    }
//  }

  var order =  ' ORDER BY ';
  if (q_column_name != q_primary_column_name) {
    order += q_column_name + ', ' + q_primary_column_name;
  } else {
    order += q_primary_column_name;
  }
  order += this.reverse ? ' DESC' : ' ASC';
  sqls.push(order);

//  if (this.key_only) {
//    sqls.push(' LIMIT ' + 100);
//  } else {
//    sqls.push(' LIMIT ' + 1);
//  }

  this.has_pending_request = true;

  /**
   * @param {SQLTransaction} transaction transaction.
   * @param {SQLResultSet} results results.
   */
  var onSuccess = function(transaction, results) {
    me.has_pending_request = false;

    me.cursor_ = results;
    me.current_cursor_index_ = 0;
    if (!!me.index_name && goog.isDefAndNotNull(ini_key)) {
      // skip them
      var cmp = ydn.db.cmp(this.getPrimaryKey(), ini_key);
      while (cmp == -1 || (cmp == 0 && exclusive)) {
        me.current_cursor_index_++;
        cmp = ydn.db.cmp(this.getPrimaryKey(), ini_key);
      }
    }
    me.onSuccess(me.getPrimaryKey(), me.getIndexKey(), me.getValue());
  };

  /**
   * @param {SQLTransaction} tr transaction.
   * @param {SQLError} error error.
   * @return {boolean} true to roll back.
   */
  var onError = function(tr, error) {
    if (ydn.db.index.req.WebsqlCursor.DEBUG) {
      window.console.log([sql, tr, error]);
    }

    me.logger.warning('get error: ' + error.message);
    me.onError(/** @type {Error} */ (error));
    return true; // roll back

  };

  var sql = sqls.join(' ');
  me.logger.finest('Iterator: ' + label + ' opened: ' + sql);
  this.tx.executeSql(sql, params, onSuccess, onError);

};



/**
 * Continue to next position.
 * @param {*} next_position next effective key.
 * @override
 */
ydn.db.index.req.WebsqlCursor.prototype.forward = function (next_position) {
  //console.log(['forward', this.current_primary_key_, this.current_key_, next_position]);
  var label = this.store_name + ':' + this.index_name;
  if (next_position === false) {
    // restart the iterator
    this.logger.finest('Iterator: ' + label + ' restarting.');
    this.open_request();
  } else if (this.hasCursor()) {
    if (goog.isDefAndNotNull(next_position)) {
      //if (goog.isArray(this.cache_keys_)) {
      if (next_position === true) {
        //this.cur['continue']();

        this.invokeNextSuccess_();

      } else {
        //console.log('continuing to ' + next_position)
        do {
          var values = this.moveNext_();
          var current_primary_key_ = values[0];
          var current_key_ = values[1];
          var current_value_ = values[2];
          if (!goog.isDef(current_key_)) {
            this.open_request(null, next_position);
            return;
          }
          if (ydn.db.cmp(current_key_, next_position) == 0) {
            this.onSuccess(this.current_primary_key_, this.current_key_, this.current_value_);
            return;
          }
        } while (goog.isDefAndNotNull(this.current_primary_key_));
        this.open_request(null, next_position);
      }
//      } else {
//        if (next_position === true) {
//          this.open_request(this.current_primary_key_, this.current_key_, true);
//        } else {
//          this.open_request(null, next_position);
//        }
//      }
    } else {
      // notify that cursor iteration is finished.
      this.onSuccess(undefined, undefined, undefined);
      this.logger.finest('Cursor: ' + label + ' resting.');
    }
  } else {
    throw new ydn.error.InvalidOperationError('Iterator:' + label + ' cursor gone.');
  }
};


/**
 * @inheritDoc
 */
ydn.db.index.req.WebsqlCursor.prototype.hasCursor = function() {
  return !!this.cursor_ && this.current_cursor_index_ < this.cursor_.rows.length;
};


/**
 * This must call only when cursor is active.
 * @return {*} return current index key.
 * @override
 */
ydn.db.index.req.WebsqlCursor.prototype.getIndexKey = function() {

  if (this.index_name) {
    if (this.current_cursor_index_ < this.cursor_.rows.length) {
      var row = this.cursor_.rows.item(this.current_cursor_index_);
      var type =  this.store_schema_.getIndex(this.index_name).getType();
      return ydn.db.schema.Index.sql2js(row[this.index_name], type);
    } else {
      return undefined;
    }
  } else {
    return undefined;
  }

};


/**
 * This must call only when cursor is active.
 * @return {*} return current primary key.
 * @override
 */
ydn.db.index.req.WebsqlCursor.prototype.getPrimaryKey = function () {
  if (this.current_cursor_index_ < this.cursor_.rows.length) {
    var primary_column_name = this.store_schema_.getColumnName();
    var row = this.cursor_.rows.item(this.current_cursor_index_);
    return ydn.db.schema.Index.sql2js(row[primary_column_name],
        this.store_schema_.getType());
  } else {
    return undefined;
  }
};


/**
 * This must call only when cursor is active.
 * @return {*} return current primary key.
 * @override
 */
ydn.db.index.req.WebsqlCursor.prototype.getValue = function() {
  var column_name = this.index_name ?
      this.index_name : this.store_schema_.getColumnName();

  if (this.current_cursor_index_ < this.cursor_.rows.length) {
    if (this.key_only) {
      return undefined;
    } else {
      if (this.index_name) {
        return undefined;
      } else {
        var row = this.cursor_.rows.item(this.current_cursor_index_);
        return ydn.db.core.req.WebSql.parseRow(/** @type {!Object} */ (row), this.store_schema_);
      }
    }
  } else {
    return undefined;
  }

};


/**
 * Continue to next primary key position.
 *
 *
 * This will continue to scan
 * until the key is over the given primary key. If next_primary_key is
 * lower than current position, this will rewind.
 * @param {*} next_primary_key
 * @param {*=} next_index_key
 * @param {boolean=} inclusive
 * @override
 */
ydn.db.index.req.WebsqlCursor.prototype.seek = function(next_primary_key,
                                         next_index_key, inclusive) {
  throw new ydn.error.NotImplementedException();
//
//  if (this.cur) {
//    var value = this.key_only ? this.cur.key : this.cur['value'];
//    var primary_cmp = ydn.db.con.IndexedDb.indexedDb.cmp(this.cur.primaryKey, next_primary_key);
//    var primary_on_track = primary_cmp == 0 || (primary_cmp == 1 && !this.reverse) || (primary_cmp == -1 && this.reverse);
//
//    if (ydn.db.index.req.WebsqlCursor.DEBUG) {
//      var s = primary_cmp === 0 ? 'next' : primary_cmp === 1 ? 'on track' : 'wrong track';
//      window.console.log(this + ' seek ' + next_primary_key + ':' + next_index_key + ' ' + s);
//    }
//
//    if (goog.isDefAndNotNull(next_index_key)) {
//      var index_cmp = ydn.db.con.IndexedDb.indexedDb.cmp(this.cur.key, next_index_key);
//      var index_on_track = (index_cmp == 1 && !this.reverse) || (index_cmp == -1 && this.reverse);
//      if (index_cmp === 0) {
//        if (primary_cmp === 0) {
//          throw new ydn.error.InternalError('cursor cannot seek to current position');
//        } else if (primary_on_track) {
//          this.cur['continue']();
//        } else {
//          // primary key not in the range
//          // this will restart the thread.
//          this.open_request(next_primary_key, next_index_key);
//        }
//      } else if (index_on_track) {
//        // just to index key position and continue
//        this.open_request(next_index_key, next_index_key);
//      } else {
//        // this will restart the thread.
//        this.logger.finest('Iterator: ' + this.label + ' restarting for ' + next_primary_key);
//        this.open_request(next_primary_key, next_index_key);
//      }
//    } else {
//      if (primary_cmp === 0) {
//        if (inclusive) {
//          throw new ydn.db.InternalError();
//        }
//        this.cur['continue']();
//        this.has_pending_request = true;
//      } else if (primary_on_track) {
//        if (!inclusive) {
//          throw new ydn.db.InternalError();
//        }
//        this.cur['continue'](next_primary_key);
//        this.has_pending_request = true;
//      } else {
//        // primary key not in the range
//        // this will restart the thread.
//        this.open_request(next_primary_key, next_index_key, inclusive);
//      }
//    }
//  } else {
//    throw new ydn.db.InternalError(this.label + ' cursor gone.');
//  }
};

