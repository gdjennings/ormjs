(function(window, undefined) {
	'use strict';

	var indexedDB,
		IDBKeyRange = window.IDBKeyRange || window.webkitIDBKeyRange,
		transactionModes = {
			readonly: 'readonly',
			readwrite: 'readwrite'
		};

	var hasOwn = Object.prototype.hasOwnProperty;

	var defaultMapper = function(value) {
		return value;
	};

	var CallbackList = function() {
		var state,
			list = [];

		var exec = function(context, args) {
			if (list) {
				args = args || [];
				state = state || [context, args];

				for (var i = 0, il = list.length; i < il; i++) {
					list[i].apply(state[0], state[1]);
				}

				list = [];
			}
		};

		this.add = function() {
			for (var i = 0, il = arguments.length; i < il; i++) {
				list.push(arguments[i]);
			}

			if (state) {
				exec();
			}

			return this;
		};

		this.execute = function() {
			exec(this, arguments);
			return this;
		};
	};

	var Server = function(db, name, schema) {
		var that = this,
		closed = false;

		this.add = function(table) {
			if (closed) {
				throw 'Database has been closed';
			}

			var records = [];
			var counter = 0;

			for (var i = 0; i < arguments.length - 1; i++) {
				if (Array.isArray(arguments[i + 1])) {
					for (var j = 0; j < (arguments[i + 1]).length; j++) {
						records[counter] = (arguments[i + 1])[j];
						counter++;
					}
				} else {
					records[counter] = arguments[i + 1];
					counter++;
				}
			}

			var transaction = db.transaction(table, transactionModes.readwrite),
				store = transaction.objectStore(table);

			return new Promise(function(resolve, reject) {
				records.forEach(function(record) {
					var req;
					if (record.item && record.key) {
						var key = record.key;
						record = record.item;
						req = store.add(record, key);
					} else {
						req = store.add(record);
					}

					req.onsuccess = function(e) {
						var target = e.target;
						var keyPath = target.source.keyPath;
						if (keyPath === null) {
							keyPath = '__id__';
						}
						Object.defineProperty(record, keyPath, {
							value: target.result,
							enumerable: true
						});
					};
				});

				transaction.oncomplete = function() {
					resolve(records, that);
				};
				transaction.onerror = function(e) {
					// prevent Firefox from throwing a ConstraintError and aborting (hard)
					// https://bugzilla.mozilla.org/show_bug.cgi?id=872873
					e.preventDefault();
					reject(e);
				};
				transaction.onabort = function(e) {
					reject(e);
				};

			});
		};

		this.update = function(table) {
			if (closed) {
				throw 'Database has been closed';
			}

			var records = [];
			for (var i = 0; i < arguments.length - 1; i++) {
				records[i] = arguments[i + 1];
			}

			return new Promise(function(resolve, reject) {
				db.transaction(function(tx) {
					var fieldNames = Object.keys(db.schema[table].fields).map(function(f){
						return quote(f);
					});
					var questionMarks = Object.keys(db.schema[table].fields).map(function(f){
						return "?";
					});

					var q = 'INSERT OR REPLACE INTO '+table+' ('+db.schema[table].key.keyPath+','+fieldNames.join(",")+') VALUES (?,'+questionMarks.join(",")+')';
					
					records.forEach(function(row) {
						var rowData = [];
						rowData.push(row[db.schema[table].key.keyPath]);
						Object.keys(db.schema[table].fields).forEach(function(field){
							if (typeof row[field] === 'object') {
								rowData.push(JSON.stringify(row[field]));
							} else {
								rowData.push(String(row[field]));
							}
						});
						tx.executeSql(q, rowData);
					});
				}, function(txError){
					console.error(txError);
					reject(txError);
				}, function(done){ 
					resolve();
				});
			});
		};

		this.remove = function(table, key) {
			if (closed) {
				throw 'Database has been closed';
			}
			var transaction = db.transaction(table, transactionModes.readwrite),
				store = transaction.objectStore(table);

			return new Promise(function(resolve, reject) {
				var req = store['delete'](key);
				transaction.oncomplete = function() {
					resolve(key);
				};
				transaction.onerror = function(e) {
					reject(e);
				};
			});
		};

		this.clear = function(table) {
			if (closed) {
				throw 'Database has been closed';
			}
			var transaction = db.transaction(table, transactionModes.readwrite),
				store = transaction.objectStore(table);

			var req = store.clear();
			return new Promise(function(resolve, reject) {
				transaction.oncomplete = function() {
					resolve();
				};
				transaction.onerror = function(e) {
					reject(e);
				};
			});
		};

		this.close = function() {
			closed = true;
			delete dbCache[name];
		};

		this.get = function(table, id) {
			if (closed) {
				throw 'Database has been closed';
			}
			return new Promise(function(resolve, reject) {
				db.readTransaction(function(tx) {
					var cmp = id;
					if (typeof id === 'string') {
						cmp = "'"+id+"'";
					} 
					var sql = "SELECT * FROM "+table+" WHERE "+db.schema[table].key.keyPath + " = " + cmp;
					tx.executeSql(sql, [], function(tx, result) {
						if (result.rows && result.rows.length === 1) {
							// convert object rows to JSON
							var obj = result.rows.item(0);
							for (var f in db.schema[table].fields) {
								if (db.schema[table].fields[f] === 'OBJECT' && obj[f]) {
									obj[f] = JSON.parse(obj[f]);
								} else if (db.schema[table].fields[f] === 'INTEGER' && obj[f]) {
									obj[f] = Number(obj[f]);
								}
							}
							resolve(obj);
						} else {
							reject('Not found');
						}
					});
				}, function(e) {
					reject(e);
				});
			});
		};

		this.query = function(table, index) {
			if (closed) {
				throw 'Database has been closed';
			}
			return new IndexQuery(table, db, index);
		};

		this.count = function(table, key) {
			if (closed) {
				throw 'Database has been closed';
			}
			var transaction = db.transaction(table),
				store = transaction.objectStore(table);
		}

		for (var tableName in db.schema) {
			(function(storeName) {
				// that[storeName] = that;
				for (var i in that) {
					if (!hasOwn.call(that, i) || i === 'close') {
						continue;
					}
					that[storeName] = that[storeName] || {};
					that[storeName][i] = (function(i) {
						return function() {
							var args = [storeName].concat([].slice.call(arguments, 0));
							return that[i].apply(that, args);
						};
					})(i);
				}
			})(tableName);
		}
	};

	var IndexQuery = function(table, db, indexName) {
		var that = this;
		var modifyObj = false;

		var runQuery = function(type, args, cursorType, direction, limitRange, filters, mapper) {
			var 
				//store = transaction.objectStore(table),
				index = indexName,
				// keyRange = type ? IDB2KeyRange[type].apply(null, args) : null,
				results = [],
				// indexArgs = [keyRange],
				limitRange = limitRange ? limitRange : null,
				filters = filters ? filters : [],
				counter = 0;

			if (cursorType !== 'count') {
				// indexArgs.push(direction || 'next');
			};

			// create a function that will set in the modifyObj properties into
			// the passed record.
			var modifyKeys = modifyObj ? Object.keys(modifyObj) : false;
			var modifyRecord = function(record) {
				for (var i = 0; i < modifyKeys.length; i++) {
					var key = modifyKeys[i];
					var val = modifyObj[key];
					if (val instanceof Function) val = val(record);
					record[key] = val;
				}
				return record;
			};
			return new Promise(function(resolve, reject) {
				var successFn = function(tx, resultSet) {
					if (resultSet.rows.length === 0) {
						return resolve([]);
					}
					for (var row = 0; row < resultSet.rows.length; row++) {
						if (limitRange !== null && limitRange[0] > row) {
							continue;
						} else if (limitRange !== null && counter >= (limitRange[0] + limitRange[1])) {
							//out of limit range... skip
						} else {
							var matchFilter = true;
							var result = resultSet.rows.item(row);
							for (var f in db.schema[table].fields) {
								if (db.schema[table].fields[f] === 'OBJECT' && result[f]) {
									result[f] = JSON.parse(result[f]);
								} else if (db.schema[table].fields[f] === 'INTEGER' && result[f]) {
									result[f] = Number(result[f]);
								}
							}
							

							filters.forEach(function(filter) {
								if (!filter || !filter.length) {
									//Invalid filter do nothing
								} else if (filter.length === 2) {
									matchFilter = matchFilter && (angular.equals(result[filter[0]], filter[1]))
								} else {
									matchFilter = matchFilter && filter[0].apply(undefined, [result]);
								}
							});

							if (matchFilter) {
								counter++;
								results.push(mapper(result));
								// if we're doing a modify, run it now
								if (modifyObj) {
									result = modifyRecord(result);
									cursor.update(result);
								}
							}
						}
					}
					resolve(results);
				};

				db.readTransaction(function(tx){
					var clause = index ? " WHERE "+index + " = '"+args[0]+"' ORDER BY "+index : '';
					if (direction === 'prev') {
						clause += " DESC";
					}
					var sql = "SELECT * FROM "+table + clause;
					tx.executeSql(sql, [], successFn);
				}, function(err){
					console.error(err);
					reject(err);
				});
			});
		};

		var Query = function(type, args) {
			var direction = 'next',
				cursorType = 'openCursor',
				filters = [],
				limitRange = null,
				mapper = defaultMapper,
				unique = false;

			var execute = function() {
				return runQuery(type, args, cursorType, unique ? direction + 'unique' : direction, limitRange, filters, mapper);
			};

			var limit = function() {
				limitRange = Array.prototype.slice.call(arguments, 0, 2)
				if (limitRange.length == 1) {
					limitRange.unshift(0)
				}

				return {
					execute: execute
				};
			};
			var count = function() {
				direction = null;
				cursorType = 'count';

				return {
					execute: execute
				};
			};
			var keys = function() {
				cursorType = 'openKeyCursor';

				return {
					desc: desc,
					execute: execute,
					filter: filter,
					distinct: distinct,
					map: map
				};
			};
			var filter = function() {
				filters.push(Array.prototype.slice.call(arguments, 0, 2));

				return {
					keys: keys,
					execute: execute,
					filter: filter,
					desc: desc,
					distinct: distinct,
					modify: modify,
					limit: limit,
					map: map
				};
			};
			var desc = function() {
				direction = 'prev';

				return {
					keys: keys,
					execute: execute,
					filter: filter,
					distinct: distinct,
					modify: modify,
					map: map
				};
			};
			var distinct = function() {
				unique = true;
				return {
					keys: keys,
					count: count,
					execute: execute,
					filter: filter,
					desc: desc,
					modify: modify,
					map: map
				};
			};
			var modify = function(update) {
				modifyObj = update;
				return {
					execute: execute
				};
			};
			var map = function(fn) {
				mapper = fn;

				return {
					execute: execute,
					count: count,
					keys: keys,
					filter: filter,
					desc: desc,
					distinct: distinct,
					modify: modify,
					limit: limit,
					map: map
				};
			};

			return {
				execute: execute,
				count: count,
				keys: keys,
				filter: filter,
				desc: desc,
				distinct: distinct,
				modify: modify,
				limit: limit,
				map: map
			};
		};

		'only bound upperBound lowerBound'.split(' ').forEach(function(name) {
			that[name] = function() {
				return new Query(name, arguments);
			};
		});

		this.filter = function() {
			var query = new Query(null, null);
			return query.filter.apply(query, arguments);
		};

		this.all = function() {
			return this.filter();
		};
	};

	function quote(arg) {
		return "\"" + arg + "\"";
	};

	var createSchema = function(e, schema, db) {
		if (typeof schema === 'function') {
			schema = schema();
		}
		return new Promise(function(resolve, reject){
			db.transaction(function(tx) {
				Object.keys(schema).forEach(function(tableName) {
					var table = schema[tableName];
					var store;
					var fieldNames = Object.keys(table.fields).map(function(f){
						return quote(f);
					});
					var sql = "CREATE TABLE IF NOT EXISTS " + tableName +"("+table.key.keyPath+" unique, " + fieldNames.join(',')+")";
					tx.executeSql(sql, null, function(){
						console.log(sql + " - OK");
					}, function(err){
						console.error(err);
					});
				});
			}, function(notOk) {
				reject(notOk);
			}, function(done) {
				console.log("Schema ready");
				resolve();
			});
		});
	};

	var open = function(e, server, version, schema) {
		var db = e.target.result;
		var s = new Server(db, server, schema);
		var upgrade;

		dbCache[server] = db;

		return s;
	};
	

	var dbCache = {};

	var db = {
		version: '0.10.2-websql',
		open: function(options) {
			return new Promise(function(resolve, reject) {
				var dbOpenResult = dbCache[options.server];
				if (dbCache[options.server]) {
					resolve();
				} else {
					var sqlDb = (window.sqlitePlugin !== undefined ? sqlitePlugin : window).openDatabase(options.server, 1, options.server, 5000000);
					sqlDb.schema = options.schema;
					createSchema({}, options.schema, sqlDb).then(function(){
						return open({target: {result: sqlDb}}, options.server, options.version, options.schema);
					}).then(function(s){
						resolve(s);
					});
				}
			});
		}
	};

	if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
		module.exports = db;
	} else if (typeof define === 'function' && define.amd) {
		define(function() {
			return db;
		});
	} else {
		window.db = db;
	}
})(window);
