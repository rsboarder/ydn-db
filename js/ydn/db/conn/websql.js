// Copyright 2012 YDN Authors. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS-IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * @fileoverview WebSQL database connector.
 *
 * @see http://www.w3.org/TR/webdatabase/
 *
 * @author kyawtun@yathit.com (Kyaw Tun)
 */

goog.provide('ydn.db.con.WebSql');
goog.require('goog.async.Deferred');
goog.require('goog.debug.Logger');
goog.require('goog.events');
goog.require('goog.functions');
goog.require('ydn.async');
goog.require('ydn.db.SecurityError');
goog.require('ydn.db.base');
goog.require('ydn.db.con.IDatabase');
goog.require('ydn.debug.error.NotImplementedException');
goog.require('ydn.json');
goog.require('ydn.string');



/**
 * Construct a WebSql database connector.
 * Note: Version is ignored, since it does work well.
 * @param {number=} opt_size estimated database size. Default to 5 MB.
 * @implements {ydn.db.con.IDatabase}
 * @constructor
 * @struct
 */
ydn.db.con.WebSql = function(opt_size) {

  // Safari default limit is slightly over 4 MB, so we ask the largest storage
  // size but, still not don't bother to user.
  // Opera don't ask user even request for 1 GB.
  /**
   * @private
   * @final
   * @type {number}
   */
  this.size_ = goog.isDef(opt_size) ? opt_size : 4 * 1024 * 1024; // 5 MB

};


/**
 * @inheritDoc
 */
ydn.db.con.WebSql.prototype.connect = function(dbname, schema) {

  var description = dbname;

  /**
   * @type {ydn.db.con.WebSql}
   */
  var me = this;

  var old_version = NaN;
  var init_migrated = false;
  var df = new goog.async.Deferred();

  /**
   *
   * @param {Database} db database.
   * @param {Error=} e error object only in case of error.
   */
  var setDb = function(db, e) {
    if (goog.isDef(e)) {
      me.sql_db_ = null;
      df.errback(e);

    } else {
      me.sql_db_ = db;
      df.callback(parseFloat(old_version));
    }
  };


  /**
   * Migrate from current version to the new version.
   * @private
   * @param {Database} db database.
   * @param {ydn.db.schema.Database} schema  schema.
   * @param {boolean=} is_version_change version change or not.
   */
  var doVersionChange_ = function(db, schema, is_version_change) {

    var action = is_version_change ? 'changing version' : 'setting version';

    var current_version = db.version ? parseInt(db.version, 10) : 0;
    var new_version = schema.isAutoVersion() ?
        is_version_change ? isNaN(current_version) ?
            1 : (current_version + 1) : current_version : schema.version;
    me.logger.finest(dbname + ': ' + action + ' from ' +
        db.version + ' to ' + new_version);

    var executed = false;
    var updated_count = 0;

    /**
     * SQLTransactionCallback
     * @param {!SQLTransaction} tx transaction object.
     */
    var transaction_callback = function(tx) {
      // sniff current table info in the database.
      me.getSchema(function(existing_schema) {
        executed = true;
        for (var i = 0; i < schema.count(); i++) {
          var counter = function(ok) {
            if (ok) {
              updated_count++;
            }
          };
          var table_info = existing_schema.getStore(schema.store(i).getName());
          // hint to sniffed schema, so that some lost info are recovered.
          var hinted_store_schema = table_info ?
              table_info.hint(schema.store(i)) : null;

          me.update_store_with_info_(tx, schema.store(i), counter,
              hinted_store_schema);
        }

        if (schema instanceof ydn.db.schema.EditableDatabase) {
          var edited_schema = schema;
          for (var j = 0; j < existing_schema.count(); j++) {
            var info_store = existing_schema.store(j);
            if (!edited_schema.hasStore(info_store.getName())) {
              edited_schema.addStore(info_store);
            }
          }
        } else {

        }

      }, tx, db);
    };

    /**
     * SQLVoidCallback
     */
    var success_callback = function() {
      var has_created = updated_count == schema.stores.length;
      if (!executed) {
        // success callback without actually executing
        me.logger.warning(dbname + ': ' + action + ' voided.');
        //if (!me.df_sql_db_.hasFired()) { // FIXME: why need to check ?
        // this checking is necessary when browser prompt user,
        // this migration function run two times: one creating table
        // and one without creating table. How annoying ?
        // testing is in /test/test_multi_storage.html page.
      } else {
        var msg = '.';
        if (updated_count != schema.stores.length) {
          msg = ' but unexpected stores exists.';
        }
        me.logger.finest(dbname + ':' + db.version + ' ready' + msg);
        setDb(db);
      }
    };

    /**
     * SQLTransactionErrorCallback
     * @param {SQLError} e error.
     */
    var error_callback = function(e) {
      throw e;
    };

    // db.transaction(transaction_callback, error_callback, success_callback);
    db.changeVersion(db.version, new_version + '', transaction_callback,
        error_callback, success_callback);

  };

  /**
   * @type {Database}
   */
  var db = null;

  var creationCallback = function(e) {
    var msg = init_migrated ?
        ' and already migrated, but migrating again.' : ', migrating.';
    me.logger.finest('receiving creation callback ' + msg);

    // the standard state that we should call VERSION_CHANGE request on
    // this callback.
    // http://www.w3.org/TR/webdatabase/#dom-opendatabase
    var use_version_change_request = true;

    //if (!init_migrated) {
    // yeah, to make sure.
    doVersionChange_(db, schema, use_version_change_request);
    //}
  };

  try {
    /**
     * http://www.w3.org/TR/webdatabase/#dom-opendatabase
     *
     * Opening robust web database is tricky. Mainly due to the fact that
     * an empty database is created even if user deny to create the database.
     */
    var version = schema.isAutoVersion() ? '' : schema.version + '';

    // From the W3C description:
    // <snap>
    // If the database version provided is not the empty string, and there is
    // already a database with the given name from the origin origin, but the
    // database has a different version than the version provided, then throw
    // an INVALID_STATE_ERR exception and abort these steps.
    // </snap>
    //
    // Since we have no way of knowing, the database with different version
    // already exist in user browser, opening a version database with specific
    // version is unwise.
    //
    // Interestingly chrome and (Safari on OS X) do not emmit INVALID_STATE_ERR
    // even if the database already exist. It simply invokes creationCallback,
    // as it should.
    //

    if (ydn.db.con.WebSql.GENTLE_OPENING) {
      // this works in Chrome, Safari and Opera
      db = goog.global.openDatabase(dbname, '', description,
          this.size_);
    } else {
      try {
        // this works in Chrome and OS X Safari even if the specified
        // database version does not exist. Other browsers throw
        // INVALID_STATE_ERR
        db = goog.global.openDatabase(dbname, version, description,
            this.size_, creationCallback);
      } catch (e) {
        if (e.name == 'INVALID_STATE_ERR') {
          // fail back to gentle opening.
          db = goog.global.openDatabase(dbname, '', description,
              this.size_);
        } else {
          throw e;
        }
      }
    }
  } catch (e) {
    if (e.name == 'SECURITY_ERR') {
      this.logger.warning('SECURITY_ERR for opening ' + dbname);
      db = null; // this will purge the tx queue
      // throw new ydn.db.SecurityError(e);
      // don't throw now, so that web app can handle without using
      // database.
      this.last_error_ = new ydn.db.SecurityError(e);

    } else {
      throw e;
    }
  }

  if (!db) {
    setDb(null, this.last_error_);
  } else {

    // Even if db version are the same, we cannot assume schema are as expected.
    // Sometimes database is just empty with given version.

    // in case previous database fail, but user granted in next refresh.
    // In this case, empty database of the request version exist,
    // but no tables.

    // WebSQL return limbo database connection,
    // if user haven't decieted whether to allow to deny the storage.
    // the limbo database connection do not execute transaction.

    // version change concept in WebSQL is broken.
    // db.transaction request can alter or create table, which suppose to
    // be done only with db.changeVersion request.

    // the approach we taking here is, we still honour visioning of database
    // but, we do not assume, opening right version will have correct
    // schema as expected. If not correct, we will correct to the schema,
    // without increasing database version.

    old_version = db.version;

    var db_info = 'database ' + dbname +
        (db.version.length == 0 ? '' : ' version ' + db.version);

    if (goog.isDefAndNotNull(schema.version) && schema.version == db.version) {
      me.logger.fine('Existing ' + db_info + ' opened as requested.');
      setDb(db);
    } else {
      // require upgrade check
      this.getSchema(function(existing_schema) {
        var msg = schema.difference(existing_schema, true);
        if (msg) {
          if (db.version.length == 0) {
            me.logger.fine('New ' + db_info + ' created.');

            doVersionChange_(db, schema, true);
          } else if (!schema.isAutoVersion()) {
            me.logger.fine('Existing ' + db_info + ' opened and ' +
                ' schema change to version ' + schema.version + ' for ' + msg);

            doVersionChange_(db, schema, true);
          } else {
            me.logger.fine('Existing ' + db_info + ' opened and ' +
                'schema change for ' + msg);

            doVersionChange_(db, schema, true);
          }

        } else {
          // same schema.
          me.logger.fine('Existing ' + db_info + ' with same schema opened.');
          setDb(db);
        }
      }, null, db);
    }

  }

  return df;
};


/**
 * @define {boolean} gentle opening do not specify version number on
 * database open method call.
 */
ydn.db.con.WebSql.GENTLE_OPENING = true;


/**
 * @inheritDoc
 */
ydn.db.con.WebSql.prototype.getType = function() {
  return ydn.db.base.Mechanisms.WEBSQL;
};


/**
 *
 * @type {Error} error.
 * @private
 */
ydn.db.con.WebSql.prototype.last_error_ = null;


/**
 * @type {Database} database instance.
 * @private
 */
ydn.db.con.WebSql.prototype.sql_db_ = null;


/**
 * @inheritDoc
 */
ydn.db.con.WebSql.prototype.getDbInstance = function() {
  return this.sql_db_ || null;
};


/**
 *
 * @return {boolean} true if supported.
 */
ydn.db.con.WebSql.isSupported = function() {
  return goog.isFunction(goog.global.openDatabase);
};


/**
 * @const
 * @type {boolean} debug flag.
 */
ydn.db.con.WebSql.DEBUG = false;


/**
 * @protected
 * @type {goog.debug.Logger} logger.
 */
ydn.db.con.WebSql.prototype.logger =
    goog.debug.Logger.getLogger('ydn.db.con.WebSql');


/**
 * @const
 * @type {string} column name prefix for multiEntry index.
 */
ydn.db.con.WebSql.PREFIX_MULTIENTRY = 'ydn.db.me:';


/**
 * Initialize variable to the schema and prepare SQL statement for creating
 * the table.
 * @private
 * @param {ydn.db.schema.Store} table table schema.
 * @return {!Array.<string>} SQL statement for creating the table.
 */
ydn.db.con.WebSql.prototype.prepareCreateTable_ = function(table) {


  // prepare schema
  var primary_type = table.getSqlType();

  var insert_statement = 'CREATE TABLE IF NOT EXISTS ';
  var sql = insert_statement + table.getQuotedName() + ' (';

  var q_primary_column = table.getSQLKeyColumnNameQuoted();
  sql += q_primary_column + ' ' + primary_type +
      ' PRIMARY KEY ';

  if (table.autoIncrement) {
    sql += ' AUTOINCREMENT ';
  }


  // every table must has a default field to store schemaless fields
  sql += ' ,' + ydn.db.base.DEFAULT_BLOB_COLUMN + ' ' +
      ydn.db.schema.DataType.BLOB;

  var sqls = [];
  var sep = ', ';
  var column_names = [q_primary_column];

  for (var i = 0, n = table.countIndex(); i < n; i++) {
    /**
     * @type {ydn.db.schema.Index}
     */
    var index = table.index(i);
    var unique = '';
    if (index.isMultiEntry()) {
      // create separate table for multiEntry
      var idx_name = ydn.db.con.WebSql.PREFIX_MULTIENTRY +
          table.getName() + ':' + index.getName();
      var idx_unique = index.isUnique() ? ' UNIQUE ' : '';
      var multi_entry_sql = insert_statement +
          goog.string.quote(idx_name) + ' (' +
          q_primary_column + ' ' + primary_type + ', ' +
          index.getSQLIndexColumnNameQuoted() + ' ' + index.getSqlType() +
          idx_unique + ')';
      sqls.push(multi_entry_sql);
      continue;
    } else if (index.isUnique()) {
      unique = ' UNIQUE ';
    }

    // http://sqlite.org/lang_createindex.html
    // http://www.sqlite.org/lang_createtable.html
    // Indexing just the column seems like counter productive. ?
    /*
     INTEGER PRIMARY KEY columns aside, both UNIQUE and PRIMARY KEY constraints
     are implemented by creating an index in the database (in the same way as a
     "CREATE UNIQUE INDEX" statement would). Such an index is used like any
     other index in the database to optimize queries. As a result, there often
     no advantage (but significant overhead) in creating an index on a set of
     columns that are already collectively subject to a UNIQUE or PRIMARY KEY
     constraint.
     */
    //if (index.type != ydn.db.schema.DataType.BLOB) {
    //  var idx_sql = 'CREATE ' + unique + ' INDEX IF NOT EXISTS ' +
    //      goog.string.quote(index.name) +
    //      ' ON ' + table_schema.getQuotedName() +
    //      ' (' + goog.string.quote(index.getKeyPath()) + ')';
    //  sqls.push(idx_sql);
    //}

    var index_key_path = index.getSQLIndexColumnNameQuoted();

    if (column_names.indexOf(index_key_path) == -1) {
      // store keyPath can also be indexed in IndexedDB spec

      sql += sep + index_key_path + ' ' + index.getSqlType() +
          unique;
      column_names.push(index_key_path);
    }

  }

  sql += ');';
  sqls.push(sql);

  return sqls;
};


/**
 * @inheritDoc
 */
ydn.db.con.WebSql.prototype.getVersion = function() {
  return this.sql_db_ ? parseFloat(this.sql_db_.version) : undefined;
};


/**
 * @inheritDoc
 */
ydn.db.con.WebSql.prototype.getSchema = function(callback, trans, db) {

  var me = this;
  db = db || this.sql_db_;

  var version = (db && db.version) ?
      parseFloat(db.version) : undefined;
  version = isNaN(version) ? undefined : version;

  /**
   * @final
   * @type {!Array.<ydn.db.schema.Store>}
   */
  var stores = [];

  /**
   * @param {SQLTransaction} transaction transaction.
   * @param {SQLResultSet} results results.
   */
  var success_callback = function(transaction, results) {

    if (!results || !results.rows) {
      return;
    }
    for (var i = 0; i < results.rows.length; i++) {

      var info = /** @type {SqliteTableInfo} */ (results.rows.item(i));
      //console.log(info);

//      name: "st1"
//      rootpage: 5
//      sql: "CREATE TABLE "st1" ("id" TEXT UNIQUE PRIMARY KEY ,
//                                 _default_ undefined )"
//      tbl_name: "st1"
//      type: "table"

//      name: "sqlite_autoindex_st1_1"
//      rootpage: 6
//      sql: null
//      tbl_name: "st1"
//      type: "index"

      if (info.name == '__WebKitDatabaseInfoTable__') {
        continue;
      }
      if (info.name == 'sqlite_sequence') {
        // internal table used by Sqlite
        // http://www.sqlite.org/fileformat2.html#seqtab
        continue;
      }
      if (info.type == 'table') {
        var sql = goog.object.get(info, 'sql');
        me.logger.finest('Parsing table schema from SQL: ' + sql);
        var str = sql.substr(sql.indexOf('('), sql.lastIndexOf(')'));
        var column_infos = ydn.string.split_comma_seperated(str);

        var key_name = undefined;
        var key_type;
        var indexes = [];
        var autoIncrement = false;
        var has_default_blob_column = false;

        for (var j = 0; j < column_infos.length; j++) {

          var fields = ydn.string.split_space_seperated(column_infos[j]);
          var upper_fields = goog.array.map(fields, function(x) {
            return x.toUpperCase();
          });
          var name = goog.string.stripQuotes(fields[0], '"');
          var type = ydn.db.schema.Index.toType(upper_fields[1]);
          // console.log([fields[1], type]);

          if (upper_fields.indexOf('PRIMARY') != -1 &&
              upper_fields.indexOf('KEY') != -1) {
            if (goog.isString(name) && !goog.string.isEmpty(name) &&
                name != ydn.db.base.SQLITE_SPECIAL_COLUNM_NAME) {
              // console.log('PRIMARY ' + name + ' on ' + info.name);
              key_name = name;
            }
            key_type = type;
            if (upper_fields.indexOf('AUTOINCREMENT') != -1) {
              autoIncrement = true;
            }
          } else if (name == ydn.db.base.DEFAULT_BLOB_COLUMN) {
            has_default_blob_column = true;
          } else {
            var unique = upper_fields[2] == 'UNIQUE';
            var index = new ydn.db.schema.Index(name, type, unique);
            //console.log(index);
            indexes.push(index);
          }
        }

        // multiEntry store, which store in separated table
        if (goog.string.startsWith(info.name,
            ydn.db.con.WebSql.PREFIX_MULTIENTRY)) {
          var names = info.name.split(':');
          if (!!names && names.length >= 3) {
            var st_name = names[1];
            var store_index = goog.array.findIndex(stores, function(x) {
              return x.getName() === st_name;
            });
            var multi_index = new ydn.db.schema.Index(names[2], type,
                unique, true);
            if (store_index >= 0) { // main table exist, add this index
              var ex_store = stores[store_index];
              indexes.push(multi_index);
              stores[store_index] = new ydn.db.schema.Store(ex_store.getName(),
                  ex_store.getKeyPath(), autoIncrement,
                  key_type, indexes, undefined, !has_default_blob_column);
            } else { // main table don't exist, create a temporary table

              stores.push(new ydn.db.schema.Store(st_name, undefined, false,
                  undefined, [multi_index]));
            }
          } else {
            me.logger.warning('Invalid multiEntry store name "' + info.name +
                '"');
          }
        } else {
          var i_store = goog.array.findIndex(stores, function(x) {
            return x.getName() === info.name;
          });
          if (i_store >= 0) {
            var ex_index = stores[i_store].index(0);
            goog.asserts.assertInstanceof(ex_index, ydn.db.schema.Index);
            indexes.push(ex_index);
            stores[i_store] = new ydn.db.schema.Store(info.name, key_name,
                autoIncrement, key_type, indexes, undefined,
                !has_default_blob_column);
          } else {
            var store = new ydn.db.schema.Store(info.name, key_name,
                autoIncrement, key_type, indexes, undefined,
                !has_default_blob_column);
            stores.push(store);
          }
        }

        //console.log([info, store]);
      }
    }

    var out = new ydn.db.schema.Database(version, stores);
    // console.log(out.toJSON());
    callback(out);
  };

  /**
   * @param {SQLTransaction} tr transaction.
   * @param {SQLError} error error.
   */
  var error_callback = function(tr, error) {
    if (ydn.db.con.WebSql.DEBUG) {
      window.console.log([tr, error]);
    }
    throw error;
  };

  if (!trans) {

    var tx_error_callback = function(e) {
      me.logger.severe('opening tx: ' + e.message);
      throw e;
    };

    db.readTransaction(function(tx) {
      me.getSchema(callback, tx, db);
    }, tx_error_callback, success_callback);

    return;
  }

  // var sql = 'PRAGMA table_info(' + goog.string.quote(table_name) + ')';
  // Invoking this will result error of:
  //   "could not prepare statement (23 not authorized)"

  var sql = 'SELECT * FROM sqlite_master';

  trans.executeSql(sql, [], success_callback, error_callback);
};


/**
 *
 * @param {SQLTransaction} trans transaction.
 * @param {ydn.db.schema.Store} store_schema schema.
 * @param {function(boolean)} callback callback on finished.
 * @private
 */
ydn.db.con.WebSql.prototype.update_store_ = function(trans, store_schema,
                                                     callback) {
  var me = this;
  this.getSchema(function(table_infos) {
    var table_info = table_infos.getStore(store_schema.name);
    me.update_store_with_info_(trans, store_schema,
        callback, table_info);
  }, trans);
};


/**
 * Alter or create table with given table schema.
 * @param {SQLTransaction} trans transaction.
 * @param {ydn.db.schema.Store} table_schema table schema to be upgrade.
 * @param {function(boolean)?} callback callback on finished. return true
 * if table is updated.
 * @param {ydn.db.schema.Store|undefined} existing_table_schema table
 * information in the existing database.
 * @private
 */
ydn.db.con.WebSql.prototype.update_store_with_info_ = function(trans,
    table_schema, callback, existing_table_schema) {

  var me = this;

  var count = 0;

  var exe_sql = function(sql) {
    /**
     * @param {SQLTransaction} transaction transaction.
     * @param {SQLResultSet} results results.
     */
    var success_callback = function(transaction, results) {
      count++;
      if (count == sqls.length) {
        callback(true);
        callback = null; // must call only once.
      }
    };

    /**
     * @param {SQLTransaction} tr transaction.
     * @param {SQLError} error error.
     */
    var error_callback = function(tr, error) {
      if (ydn.db.con.WebSql.DEBUG) {
        window.console.log([tr, error]);
      }
      count++;
      if (count == sqls.length) {
        callback(false); // false for no change
        callback = null; // must call only once.
      }
      var msg = goog.DEBUG ? 'SQLError creating table: ' +
          table_schema.name + ' ' + error.message + ' for executing "' +
          sql : '"';
      throw new ydn.db.SQLError(error, msg);
    };

    trans.executeSql(sql, [], success_callback, error_callback);
  };

  var sqls = this.prepareCreateTable_(table_schema);

  var action = 'Create';
  if (existing_table_schema) {
    // table already exists.
    var msg = table_schema.difference(existing_table_schema);
    if (msg.length == 0) {
      me.logger.finest('same table ' + table_schema.name + ' exists.');
      callback(true);
      callback = null;
      return;
    } else {
      action = 'Modify';

      // TODO: use ALTER
      this.logger.warning(
          'table: ' + table_schema.name + ' has changed by ' + msg +
          ' additionallly TABLE ALTERATION is not implemented, ' +
          'dropping old table.');
      sqls.unshift('DROP TABLE IF EXISTS ' +
          goog.string.quote(table_schema.name));
    }
  }

  if (ydn.db.con.WebSql.DEBUG) {
    window.console.log([sqls, existing_table_schema]);
  }

  me.logger.finest(action + ' table: ' + table_schema.name + ': ' +
      sqls.join(';'));
  for (var i = 0; i < sqls.length; i++) {
    exe_sql(sqls[i]);
  }

};


/**
 * @inheritDoc
 */
ydn.db.con.WebSql.prototype.isReady = function() {
  return !!this.sql_db_;
};


/**
 * @final
 */
ydn.db.con.WebSql.prototype.close = function() {
  // WebSQl API do not have close method.
};


/**
 * @inheritDoc
 * @protected
 */
ydn.db.con.WebSql.prototype.doTransaction = function(trFn, scopes, mode,
                                                     completed_event_handler) {

  var me = this;

  /**
   * SQLTransactionCallback
   * @param {!SQLTransaction} tx transaction.
   */
  var transaction_callback = function(tx) {
    trFn(tx);
  };

  /**
   * SQLVoidCallback
   */
  var success_callback = function() {
    completed_event_handler(ydn.db.base.TxEventTypes.COMPLETE,
        {'type': ydn.db.base.TxEventTypes.COMPLETE});
  };

  /**
   * SQLTransactionErrorCallback
   * @param {SQLError} e error.
   */
  var error_callback = function(e) {
    me.logger.finest(me + ': Tx ' + mode + ' request cause error.');
    completed_event_handler(ydn.db.base.TxEventTypes.ERROR, e);
  };

  if (goog.isNull(this.sql_db_)) {
    // this happen on SECURITY_ERR
    trFn(null);
    completed_event_handler(ydn.db.base.TxEventTypes.ERROR,
        this.last_error_);
  }

  if (mode == ydn.db.base.TransactionMode.READ_ONLY) {
    this.sql_db_.readTransaction(transaction_callback,
        error_callback, success_callback);
  } else if (mode == ydn.db.base.TransactionMode.VERSION_CHANGE) {
    var next_version = this.sql_db_.version + 1;
    this.sql_db_.changeVersion(this.sql_db_.version, next_version + '',
        transaction_callback, error_callback, success_callback);
  } else {
    this.sql_db_.transaction(transaction_callback,
        error_callback, success_callback);
  }

};


/**
 *
 * @param {string} db_name database name to be deleted.
 */
ydn.db.con.WebSql.deleteDatabase = function(db_name) {
  // WebSQL API does not expose deleting database.
  // Dropping all tables indeed delete the database.
  var db = new ydn.db.con.WebSql();
  var schema = new ydn.db.schema.EditableDatabase();
  db.logger.finer('deleting websql database: ' + db_name);
  var df = db.connect(db_name, schema);

  var on_completed = function(t, e) {
    db.logger.info('all tables in ' + db_name + ' deleted.');
  };

  df.addCallback(function() {

    db.doTransaction(function delete_tables(tx) {

      /**
       * @param {SQLTransaction} transaction transaction.
       * @param {SQLResultSet} results results.
       */
      var success_callback = function(transaction, results) {
        if (!results || !results.rows) {
          return;
        }
        var n = results.rows.length;
        var del = 0;
        for (var i = 0; i < n; i++) {
          var info = /** @type {SqliteTableInfo} */ (results.rows.item(i));
          if (info.name == '__WebKitDatabaseInfoTable__' ||
              info.name == 'sqlite_sequence') {
            continue;
          }
          del++;
          db.logger.finest('deleting table: ' + info.name);
          tx.executeSql('DROP TABLE ' + info.name);
        }
        db.logger.finer(del + ' tables deleted from "' + db_name + '"');
      };

      /**
       * @param {SQLTransaction} tr transaction.
       * @param {SQLError} error error.
       */
      var error_callback = function(tr, error) {
        if (ydn.db.con.WebSql.DEBUG) {
          window.console.log([tr, error]);
        }
        throw error;
      };


      var sql = 'SELECT * FROM sqlite_master WHERE type = "table"';

      tx.executeSql(sql, [], success_callback, error_callback);

    }, [], ydn.db.base.TransactionMode.READ_WRITE, on_completed);

  });
  df.addErrback(function() {
    db.logger.warning('Connecting ' + db_name + ' failed.');
  });
};


if (goog.DEBUG) {
  /**
   * @override
   */
  ydn.db.con.WebSql.prototype.toString = function() {
    var s = this.sql_db_ ? ':' + this.sql_db_.version : '';
    return 'WebSql:' + s;
  };
}
