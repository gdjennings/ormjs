angular.module("ormjs", [])
.factory("Persistence", function($http, $q) {
	var persistence = {};

	persistence.isImmutable = function(fieldName) {
		return (fieldName === "id");
	};

	/**
	 * Default implementation for entity-property
	 */
	persistence.defineProp = function(scope, field, setterCallback, getterCallback) {
		if (typeof (scope.__defineSetter__) === 'function' && typeof (scope.__defineGetter__) === 'function') {
			scope.__defineSetter__(field, function(value) {
				setterCallback(value);
			});
			scope.__defineGetter__(field, function() {
				return getterCallback();
			});
		} else {
			Object.defineProperty(scope, field, {
				get: getterCallback,
				set: function(value) {
					setterCallback(value);
				},
				enumerable: true, configurable: true
			});
		}
	};

	/**
	 * Default implementation for entity-property setter
	 */
	persistence.set = function(scope, fieldName, value) {
		if (persistence.isImmutable(fieldName))
			throw new Error("immutable field: " + fieldName);
		scope[fieldName] = value;
	};

	/**
	 * Default implementation for entity-property getter
	 */
	persistence.get = function(arg1, arg2) {
		return (arguments.length === 1) ? arg1 : arg1[arg2];
	};

	(function() {
		var entityMeta = {};
		var entityClassCache = {};
		persistence.getEntityMeta = function() {
			return entityMeta;
		};

		// Per-session data
		persistence.trackedObjects = {};

		// Public Extension hooks
		persistence.dbname = 'anonymous';
		persistence.endpoint = '';

		// Enable debugging (display queries using console.log etc)
		persistence.debug = true;
		persistence.syncMeta = {
			txSequence : localStorage['sync.meta.tx'] || 1,
			cacheVersion : 1,
			listeners: {}

		};


		persistence.config = function(db, uri) {
			this.dbname = db || 'anonymous';
			this.endpoint = uri;
			this.baseUrl = uri;

		};


		/**
		 * Retrieves metadata about entity, mostly for internal use
		 */
		function getMeta(entityName) {
			return entityMeta[entityName];
		}

		persistence.getMeta = getMeta;


		function qCallback(callback, args) {
			var p = $q.defer();
			if (callback) callback(args);
			p.resolve(args);
			return p.promise;
		}
		/**
		 * Define an entity
		 *
		 * @param entityName
		 *            the name of the entity (also the table name in the database)
		 * @param fields
		 *            an object with property names as keys and SQLite types as
		 *            values, e.g. {name: "TEXT", age: "INT"}
		 * @return the entity's constructor
		 */
		persistence.define = function(entityName, fields) {
			if (entityMeta[entityName]) { // Already defined, ignore
				return getEntity(entityName);
			}
			var meta = {
				name: entityName,
				fields: fields,
				indexes: {},
				hasMany: {},
				hasOne: {}
			};
			angular.forEach(fields, function(t, f){
				if (f.indexOf('@') === -1 && t !== "BOOLEAN" && t !== "OBJECT") {
					meta.indexes[f] = {};
				}
			});
			meta.indexes.id = {};
			persistence.trackedObjects[entityName] = {};
			entityMeta[entityName] = meta;
			return getEntity(entityName);
		};

		persistence.schemaSync = function(callback) {
			persistence.syncMeta.lastChange = -1;
			persistence.syncMeta.lastSharedChange = -1;

			persistence.syncMeta.indexedDbSchema = {};
			persistence.syncMeta.sharedDbSchema = {};
			var meta = persistence.getEntityMeta();
			for (var table in meta) {
				if (meta.hasOwnProperty(table)) {
					var schema = persistence.syncMeta.indexedDbSchema;
					if (meta[table].cacheMode === 'shared') {
						schema = persistence.syncMeta.sharedDbSchema;
					}
					schema[table] = {
						key: { keyPath: 'id' },
						indexes : meta[table].indexes,
						fields: meta[table].fields
					};
					
					for (var rel in meta[table].hasOne) {
						schema[table].fields[rel] = "TEXT";
					}
				}
			}
			persistence.syncMeta.indexedDbSchema['UNSYNCED_DELETE'] = {
				key: { keyPath: 'id' },
				indexes: { },
				fields: {
					value: "OBJECT"
				}
			};
			persistence.syncMeta.indexedDbSchema['CHANGESET'] = {
				key: { keyPath: 'id' },
				indexes: { },
				fields: {
					root: "TEXT",
					committed: "TIMESTAMP"
				}
			};
			persistence.syncMeta.sharedDbSchema['ROOTS'] = {
				key: { keyPath: 'id'},
				indexes: { },
				fields: {
					value: "OBJECT"
				}
			};
			persistence.syncMeta.sharedDbSchema['CHANGESET'] = {
				key: { keyPath: 'id' },
				indexes: { },
				fields: {
					root: "TEXT",
					committed: "TIMESTAMP"
				}
			};

			// this is where we can load the persistent entities
			try {
				return db.open( {
						server: 'common',
						version: 5,
						schema: persistence.syncMeta.sharedDbSchema
				} ).then( function ( s ) {
						persistence.syncMeta.sharedConnection = s;
						callback();
				} ).catch(function(err){
					console.error(err);
					// alert('Local storage failed. Offline unavailable');
					callback();
				});
			} catch (offlineProblem) {
				console.log(offlineProblem);
//				alert('This browser does not support a necessary feature (IndexedDB) to enable offline. Ensure you have a reliable internet connection or try a different browser');
				callback();
				return;

			}

		};

		cacheCreateOrUpdate = function(connection, t, ent) {
			if (connection && connection[t]) {
				var json = ent.toJSON ? ent.toJSON() : ent;
				return connection[t].update(json);
			} else {
				return qCallback(null, null);
			}
		};

		function toDb(model, root) {
			var complete = $q.defer();
			var allComplete = [];
			var modelByType = {};
			for (var x in model) {
				modelByType[model[x]._type] = modelByType[model[x]._type] || [];
				modelByType[model[x]._type].push(model[x].toJSON ? model[x].toJSON() : model[x]);
			}
			
			for (var type in modelByType) {
				var cx = (persistence.getMeta(type) || '').cacheMode == 'shared' ? persistence.syncMeta.sharedConnection : persistence.syncMeta.connection;
				console.log("Update: "+type+" x " + modelByType[type].length);
				allComplete.push(cx[type].update.apply(null, modelByType[type]));
			}
			if (root) {
				allComplete.push(cacheCreateOrUpdate(persistence.syncMeta.sharedConnection, 'ROOTS', root));
			}
			return $q.all(allComplete);
		}



		/**
		 * Checks whether an entity exists
		 *
		 * @param entityName
		 *            the name of the entity (also the table name in the database)
		 * @return `true` if the entity exists, otherwise `false`
		 */
		persistence.isDefined = function(entityName) {
			return !!entityMeta[entityName];
		};

		/**
		 * Adds the object to tracked entities to be persisted
		 *
		 * @param obj
		 *            the object to be tracked
		 */
		persistence.track = function(obj) {
			if (!obj)
				return;
			var entityName = obj._type;
			if (!this.trackedObjects[entityName])
				this.trackedObjects[entityName] = {};
			this.trackedObjects[entityName][obj.id] = obj;
			return this;
		}

		persistence.namedQuery = function(queryName, queryParams, data, callback) {
			var url = this.baseUrl+'/scoring/insecure/namedquery/'+queryName+'?skip='+queryParams.skip+'&limit='+queryParams.limit;
			return $http.post(url, data).then(function(response){
				callback(response.data);
			}, function(err){
				throw err;
			});
		};

		persistence.getCacheRoots = function(_type, callback) {
			if (persistence.syncMeta.sharedConnection != null) {
				return persistence.syncMeta.sharedConnection.ROOTS.query().all().execute().then(function(entities){
					var model = {};
					model[_type] = entities;
					persistence.load(model, callback);
				});
			} else {
				return qCallback(callback);
			}
		};

		function refreshCache(raw, callback) {
			// revive deletes
			var deletedEntities = raw.UNSYNCED_DELETE;
			delete raw.UNSYNCED_DELETE;
			for (var d in deletedEntities) {
				persistence.deleteList.push(deletedEntities[d]);
			}
			persistence.load(raw, function(entities){
				for(var v in entities) {
					var ths = entities[v];
					if (ths.changeSet == null && persistence.getMeta(ths._type).syncMode !== 'ReadOnly') {
						ths._new = true;
						if (!persistence.dirtyList[ths._type]) {
							persistence.dirtyList[ths._type] = {};
						}
						persistence.dirtyList[ths._type][ths.id] = ths;
					} else if ((ths.changeSet === -1 ||ths.changeSet > persistence.syncMeta.lastChange)
									&& persistence.getMeta(ths._type).syncMode !== 'Immutable') {
						if (!persistence.dirtyList[ths._type]) {
							persistence.dirtyList[ths._type] = {};
						}
						persistence.dirtyList[ths._type][ths.id] = ths;
					}
				}
				callback(true);
			});
		}

		persistence.initCache = function(dbName) {
			if (persistence.syncMeta.root === dbName && persistence.syncMeta.connection) {
				return qCallback(null, false);
			}
			persistence.syncMeta.root = dbName;
			try {
				db.version = 5;
				return db.open( {
						server: dbName,
						version: 5,
						schema: persistence.syncMeta.indexedDbSchema
				} ).then( function ( s ) {
					persistence.syncMeta.connection = s;
					return s;
				} );
			} catch (offlineError) {
				console.error(offlineError);
				return qCallback(callback, false);
			}
		};


		function onSync(model, root, callback) {
			console.log("Enter: onSync() @" + new Date().getTime());
			persistence.syncMeta.fatalities = 0;
			// load changes
			var lastChange = model.latestChangeSet;
			delete model.latestChangeSet;
			var remoteDeleted = model.DELETED;
			if (remoteDeleted) {
				delete model.DELETED;
			}
			persistence.load(model, function(loaded){
				// clean up any stray deleted entities
				angular.forEach(remoteDeleted, function(entity) {
					var entityId = entity.id;
					var entityName = entity._type;
					persistence.syncMeta.connection[entityName].remove(entityId);
				});
				
				toDb(loaded, persistence.trackedObjects[root._type][root.id]).then(function(){
					if (lastChange) {
						persistence.syncMeta.lastSharedChange = lastChange.id;
						persistence.syncMeta.lastChange = lastChange.id;
						cacheCreateOrUpdate(persistence.syncMeta.connection, 'CHANGESET', lastChange);
						cacheCreateOrUpdate(persistence.syncMeta.sharedConnection, 'CHANGESET', lastChange);
					}

					console.log('Sync completed @ ' + new Date().getTime());
					if (persistence.trackedObjects[root._type][root.id]) { // is already being tracked
						callback(persistence.trackedObjects[root._type][root.id]);	
					} else { // load it from cache
						var rootEntityType = getEntity(root._type);
						rootEntityType.load(root.id, function(loadedRoot){
							callback(loadedRoot);
						});
					}
					
				}).catch(function(e){
					console.error(e);
					callback(null);
				});
			});
			notify('synchronize', 0);
		}

		function loadLastSync(connection) {
			if (connection) {
				return connection['CHANGESET'].query().all().desc().execute().then(function(changesets){
					return (changesets || [])[0];
				});
			} else {
				var x = $q.defer();
				x.resolve(null);
				return x.promise;
			}

		}

		persistence.synchronise = function(root, callback) {
			// check local copy

			if (persistence.syncMeta.root !== root.id) {
				persistence.syncMeta.root = root.id;
				persistence.syncMeta.connection = null;
			}

			// if the last changeset I have in memory is < changeset on disk, a sync must have happened in a different window
			// so I should refresh
			return persistence.initCache(root.id).then(function() {
				var l1 = loadLastSync(persistence.syncMeta.connection).then(function(latestChangeset) {
					if (latestChangeset && persistence.syncMeta.lastChange < latestChangeset.id) {
						persistence.syncMeta.lastChange = latestChangeset.id;
						return true;
					} else {
						persistence.syncMeta.lastChange = (latestChangeset || {id: -1}).id;
						return false;
					}
				});
				var l2 = loadLastSync(persistence.syncMeta.sharedConnection).then(function(latestChangeset) {
					if (latestChangeset && persistence.syncMeta.lastSharedChange < latestChangeset.id) {
						persistence.syncMeta.lastSharedChange = latestChangeset.id;
						return true;
					} else {
						persistence.syncMeta.lastSharedChange = (latestChangeset || {id: -1}).id;
						return false;
					}
				});
				return $q.all([l1,l2]);
			}).then(function(){
				var syncUrl = persistence.baseUrl+'/scoring/secure/sync/'+root.id+'?since='+(persistence.syncMeta.lastChange || -1)+'&sharedSince='+(persistence.syncMeta.lastSharedChange || -1);
					// create new entities first

				return $http.post(syncUrl, {});
				
			}).then(function(response) {
				return onSync(response.data, root, callback);
			}).catch(function(xhr) {
				// sync every 60 seconds
				// assume offline
				notify('offline', 'synchronize');
				callback(null);
			});
		};

		function notify(m, detail){
			var event;// = new CustomEvent('synchronize', {'detail': 0});
				if (!window.CustomEvent) {
					event = document.createEvent('CustomEvent');
					event.initCustomEvent( m, true, true, detail );
				} else {
					event = new CustomEvent(m, {'detail': detail});
				}
				window.dispatchEvent(event);

		}

		/**
		 * Clean the persistence context of cached entities and such.
		 */
		persistence.clean = function() {
			var meta = persistence.getEntityMeta();
			for (var table in meta) {
				if (meta.hasOwnProperty(table)) {
					if (meta[table].cacheMode !== 'shared') {
						this.trackedObjects[table] = {};
					}
				}
			}

			this.syncMeta.lastChange = -1;
			this.syncMeta.lastSharedChange = -1;
			if (persistence.syncMeta.connection)
				persistence.syncMeta.connection.close();
			delete persistence.syncMeta.connection;
			persistence.syncMeta.fatalities = 0;
		};

		persistence.disintegrate = function() {
			var indexedDB = window.indexedDB || window.webkitIndexedDB || window.mozIndexedDB || window.oIndexedDB || window.msIndexedDB;
			if (indexedDB ) {
				persistence.getCacheRoots("COMPETITION", function(roots){
					angular.forEach(roots, function(root){
						indexedDB.deleteDatabase(root.id);
					});
					indexedDB.deleteDatabase('common');
				});
			}
		}

		/**
		 * asynchronous sequential version of Array.prototype.forEach
		 * @param array the array to iterate over
		 * @param fn the function to apply to each item in the array, function
		 *        has two argument, the first is the item value, the second a
		 *        callback function
		 * @param callback the function to call when the forEach has ended
		 */
		persistence.asyncForEach = function(array, fn, callback) {
			array = array.slice(0); // Just to be sure
			function processOne() {
				var item = array.pop();
				fn(item, function(result, err) {
					if (array.length > 0) {
						processOne();
					} else {
						callback(result, err);
					}
				});
			}
			if (array.length > 0) {
				processOne();
			} else {
				callback();
			}
		};

		/**
		 * Retrieves or creates an entity constructor function for a given
		 * entity name
		 * @param entityName
		 * @return the entity constructor function to be invoked with `new fn()`
		 */
		function getEntity(entityName) {
			if (entityClassCache[entityName]) {
				return entityClassCache[entityName];
			}
			var meta = entityMeta[entityName];
			if (!persistence.trackedObjects.hasOwnProperty(entityName)) {
				persistence.trackedObjects[entityName] = {};
			}

			/**
			 * @constructor
			 * @param obj name description
			 */
			function Entity(obj) {
				var that = this;
				obj = obj || {};
				this.id = obj.id || persistence.createUUID();
				this._new = true;
				this._type = entityName;
				this._dirtyProperties = {};
				this._data = {};
				this._data_obj = {}; // references to objects

				for (var field in meta.fields) {
					(function() {
						if (meta.fields.hasOwnProperty(field)) {
							var f = field; // Javascript scopes/closures SUCK
							persistence.defineProp(that, f, function(val) {
								// setterCallback
								var oldValue = that._data[f];
								if (oldValue !== val || (oldValue && val && oldValue.getTime && val.getTime)) { // Don't mark properties as dirty
									that._data[f] = val;
									that.markDirty(f, oldValue);
									//that._dirtyProperties[f] = oldValue;

								}
							}, function() {
								// getterCallback
								if (f === 'id' || that._loaded || that._new)
									return that._data[f];
								else {
									//throw new Error("Property '" + f + "' of '" + meta.name + "' with id: " + that.id + " not fetched, either prefetch it or fetch it manually.");
									console.error("Property '" + f + "' of '" + meta.name + "' with id: " + that.id + " not fetched, either prefetch it or fetch it manually.");
								}
							});
							that._data[field] = defaultValue(meta.fields[field]);
						}
					}());
				}

				for (var it in meta.hasOne) {
					if (meta.hasOne.hasOwnProperty(it)) {
						(function() {
							var ref = it;
							persistence.defineProp(that, ref, function(val) {
								// setterCallback
								var oldValue = that._data[ref];
								var refType = meta.hasOne[ref].type.meta.name;
								if (!persistence.trackedObjects[refType]) persistence.trackedObjects[refType] = {};
								var oldValueObj = that._data_obj[ref] || persistence.trackedObjects[refType][that._data[ref]];
								if (val == null) {
									that._data[ref] = null;
									that._data_obj[ref] = undefined;
								} else if (val.id) {
									that._data[ref] = val.id;
									that._data_obj[ref] = val;
								} else { // let's assume it's an id
									that._data[ref] = val;
									that._data_obj[ref] = val;
								}
								that.markDirty(ref, oldValue);
								// Inverse
							}, function() {
								// getterCallback
								if (!that._data[ref]) {
									return null;
								} else if (that._data_obj[ref] !== undefined) {
									return that._data_obj[ref];
								} else if (that._data[ref]) {
									if (persistence.trackedObjects[meta.hasOne[ref].type.meta.name][that._data[ref]]) {
										that._data_obj[ref] = persistence.trackedObjects[meta.hasOne[ref].type.meta.name][that._data[ref]];
									} else {
										that._data_obj[ref] = new Entity();
										that._data_obj[ref]._loaded = false;
										that._data_obj[ref].id = that._data[ref];
									}
									return that._data_obj[ref];
								} else {
//									alert('The system is attempting to perform an operation on ' + meta.name + ' but it was not fetched from the server. ' +
//													'This is not supposed to happen and the page will need to be refreshed. Take a note of the steps led to this error and notify the development team.');

									//throw new Error("Property '" + ref + "' of '" + meta.name + "' with id: " + that._data[ref] + " not fetched, either prefetch it or fetch it manually.");
									console.error("Property '" + ref + "' of '" + meta.name + "' with id: " + that._data[ref] + " not fetched, either prefetch it or fetch it manually.");
								}
							});
						}());
					}
				}

				for (var it in meta.hasMany) {
					if (meta.hasMany.hasOwnProperty(it)) {
						(function() {
							var coll = it;
							if (meta.hasMany[coll].manyToMany) {
								persistence.defineProp(that, coll, function(val) {
									// setterCallback
									if (val && val._items) {
										// Local query collection, just add each item
										// TODO: this is technically not correct, should clear out existing items too
										var items = val._items;
										for (var i = 0; i < items.length; i++) {
											persistence.get(that, coll).add(items[i]);
										}
									} else {
										throw new Error("Not yet supported.");
									}
								}, function() {
									// getterCallback
									if (that._data[coll]) {
										return that._data[coll];
									} else {
										var rel = meta.hasMany[coll];
										var inverseMeta = rel.type.meta;
										var inv = inverseMeta.hasMany[rel.inverseProperty];
										var direct = meta.name;
										var inverse = inverseMeta.name;

										var queryColl = new persistence.ManyToManyDbQueryCollection(inverseMeta.name);
										queryColl.initManyToMany(that, coll);
										queryColl._manyToManyFetch = {
											table: rel.tableName,
											prop: direct + '_' + coll,
											inverseProp: inverse + '_' + rel.inverseProperty,
											id: that.id
										};
										that._data[coll] = queryColl;
										return that._data[coll];
									}
								});
							} else { // one to many
								persistence.defineProp(that, coll, function(val) {
									// setterCallback
									if (val && val._items) {
										// Local query collection, just add each item
										// TODO: this is technically not correct, should clear out existing items too
										var items = val._items;
										for (var i = 0; i < items.length; i++) {
											persistence.get(that, coll).add(items[i]);
										}
									} else {
										throw new Error("Not yet supported.");
									}
								}, function() {
									// getterCallback
									if (that._data[coll]) {
										return that._data[coll];
									} else {
										var queryColl = new persistence.DbQueryCollection(meta.hasMany[coll].type.meta.name).only(meta.hasMany[coll].inverseProperty, that.id);
										that._data[coll] = queryColl;
										return queryColl;
									}
								});
							}
						}());
					}
				}

				if (this.initialize) {
					this.initialize();
				}

				for (var f in obj) {
					if (obj.hasOwnProperty(f)) {
						if (f !== 'id') {
							persistence.set(that, f, obj[f]);
						}
					}
				}
			} // Entity

			Entity.meta = meta;

			Entity.prototype.equals = function(other) {
				if (other == null || !other.hasOwnProperty('id'))
					return false;
				return (this.id === other.id && this._type === other._type);
			};

			// is other newer than this
			Entity.prototype.compareVersion = function(other) {
				// its newer if:
				if (this._data.changeSet == null) { // this has no changeset property
					return 1;
				} else {
					if (other.changeSet == null) {// other has no changeset, keep this one
						return 0;
					} else {
						return other.changeSet.id - this._data.changeSet.id;
					}
				}
				return -1;
			};

			Entity.prototype.toJSON = function(sync) {
				var meta = persistence.getMeta(this._type);
				var json = {id: this.id};
				for (var p in meta.fields) {
					if (this._data.hasOwnProperty(p) && this._data[p] != null) {
						json[p] = 
						//dynamo ? {
						//	S: String(this._data[p])
						//} : 
						this._data[p];
					}
				}

				if (meta.cacheMode === 'shared' && meta.syncMode !== 'ReadOnly') {
					// append _dirty
					json._dirty = this._new || (Object.keys(this._dirtyProperties).length > 0);
				}

				for (var q in meta.hasOne) {
					if (this._data.hasOwnProperty(q) && this._data[q] != null) {
						json[q] = 
							//dynamo ? {S: String(this.data[q])} : 
						sync ? {id: this._data[q]} : this._data[q];
					}
				}

/*
				for (var r in meta.hasMany) {
					if (this[r] != null && this[r].toJSON !== undefined)
						json[r] = this[r].toJSON();
				}
				*/
				return json;
			};

			Entity.prototype.fetch = function(rel, callback) {

				var that = this;

				if (!this._data[rel]) { // null
					if (callback) {
						callback(null);
					}
				} else if (this._data_obj[rel] && this._data_obj[rel]._loaded) { // already loaded
					if (callback) {
						callback(this._data_obj[rel]);
					}
				} else {
					var type = meta.hasOne[rel].type;
					type.load(this._data[rel], function(obj) {
						that._data_obj[rel] = obj;
						if (callback) {
							callback(obj);
						}
					});
				}
			};

			/**
			 * Currently this is only required when changing JSON properties
			 */
			Entity.prototype.markDirty = function(prop, oldValue) {
				this._dirtyProperties[prop] = oldValue ? oldValue : true;
				var meta = persistence.getMeta(this._type);
				if (meta.syncMode !== 'ReadOnly') {
					if (persistence.trackedObjects[this._type][this.id]) {
						if (!persistence.dirtyList[this._type])
							persistence.dirtyList[this._type] = {};
						persistence.dirtyList[this._type][this.id] = this;
						if (this.changeSet != null)
							this.changeSet = persistence.syncMeta.lastChange + 1;
						//persistence.flush();
					}
				}
			};

			/**
			 * Returns a QueryCollection implementation matching all instances
			 * of this entity in the database
			 */
			Entity.all = function() {
				return new AllDbQueryCollection(entityName);
			};

			Entity.load = function(id, callback) {
				if (id == null && callback)
					return qCallback(callback);
				else {
					var conn;
					if (meta.cacheMode !== 'shared') {
						conn = persistence.syncMeta.connection[meta.name];
					} else {
						conn = persistence.syncMeta.sharedConnection[meta.name];
					}
					return conn.get(id).then(function(raw){
						var blob = {};
						blob[meta.name] = [raw];
						var ent = persistence.load(blob)[0];
						if (callback) callback(ent);
						return ent;
					});
				}
					//return Entity.findBy('id', id, callback);
			};

			Entity.findBy = function(property, value, callback) {

				if (property === 'id' && persistence.trackedObjects[entityName] && value in persistence.trackedObjects[entityName]) {
					if (persistence.trackedObjects[entityName][value]._loaded || persistence.trackedObjects[entityName][value]._new) {
						return qCallback(callback, persistence.trackedObjects[entityName][value]);
					}
				}
				return Entity.all().filter(property, "=", value).one(function(obj) {
					if (callback) callback(obj);
					return obj;
				});
			};


			// Entity.index = function(cols, options) {
			// 	var opts = options || {};
			// 	if (typeof cols == "string") {
			// 		cols = [cols];
			// 	}
			// 	opts.columns = cols;
			// 	meta.indexes.push(opts);
			// };
			
			// Entity.indexes = function(indexSpec) {
			// 	meta.indexes = indexSpec
			// }

			/**
			 * Declares a one-to-many or many-to-many relationship to another entity
			 * Whether 1:N or N:M is chosed depends on the inverse declaration
			 * @param collName the name of the collection (becomes a property of
			 *   Entity instances
			 * @param otherEntity the constructor function of the entity to define
			 *   the relation to
			 * @param inverseRel the name of the inverse property (to be) defined on otherEntity
			 */
			Entity.hasMany = function(collName, otherEntity, invRel) {
				var otherMeta = otherEntity.meta;
				if (otherMeta.hasMany[invRel]) {
					// other side has declared it as a one-to-many relation too -> it's in
					// fact many-to-many
					var tableName = meta.name + "_" + collName + "_" + otherMeta.name;
					var inverseTableName = otherMeta.name + '_' + invRel + '_' + meta.name;

					if (tableName > inverseTableName) {
						// Some arbitrary way to deterministically decide which table to generate
						tableName = inverseTableName;
					}
					meta.hasMany[collName] = {
						type: otherEntity,
						inverseProperty: invRel,
						manyToMany: true,
						tableName: tableName
					};
					otherMeta.hasMany[invRel] = {
						type: Entity,
						inverseProperty: collName,
						manyToMany: true,
						tableName: tableName
					};
					delete meta.hasOne[collName];
					delete meta.indexes[colName];
					delete meta.fields[collName + "_class"]; // in case it existed
				} else {
					meta.hasMany[collName] = {
						type: otherEntity,
						inverseProperty: invRel
					};
					otherMeta.hasOne[invRel] = {
						type: Entity,
						inverseProperty: collName
					};
					otherMeta.indexes[invRel] = {}
				}
			};

			Entity.hasOne = function(refName, otherEntity, inverseProperty) {
				meta.hasOne[refName] = {
					type: otherEntity,
					inverseProperty: inverseProperty
				};
				meta.indexes[refName] = {}
			};

			/* Add some of the search functionality also */

			/**
			 * Declares a property to be full-text indexed.
			 */
			Entity.textIndex = function(prop) {
				if (Entity.meta.textIndex == null) {
					Entity.meta.textIndex = {};
				}
				Entity.meta.textIndex[prop] = true;
			};
			/**
			 * Declares an entity to be tracked for changes
			 */
			Entity.syncMode = function(mode) {
				Entity.meta.syncMode = mode;
//		  Entity.meta.syncUri = uri;
				Entity.meta.fields['_lastChange'] = 'BIGINT';
			};
			/**
			 * Informs the cache about how long to hold
			 * mode: persist, none, [normal]
			 */
			Entity.cacheMode = function(mode) {
				Entity.meta.cacheMode = mode;
			};

			Entity.origin = function(origin) {
				Entity.meta.origin = origin;
			};

			Entity.cascadeUpdate = function(rel) {
				Entity.meta.hasMany[rel].cascade = true;
			};


			/**
			 * Returns a query collection representing the result of a search
			 * @param query an object with the following fields:
			 */
			Entity.search = function(query) {

				var dbColl = new persistence.DbQueryCollection(Entity.meta.name);
				dbColl._filter = null;
				// filter is an OR of each textIndex'd property LIKE %query%
				for (var p in  Entity.meta.textIndex) {
					if (Entity.meta.textIndex.hasOwnProperty(p)) {
						if (dbColl._filter == null) {
							dbColl._filter = new persistence.PropertyFilter(p, 'LIKE', query.replace(/\*/g, '%'));
						} else {
							dbColl._filter = new persistence.OrFilter(dbColl._filter, new persistence.PropertyFilter(p, 'LIKE', query.replace(/\*/g, '%')));
						}
					}
				}
				return dbColl;
			};

			entityClassCache[entityName] = Entity;
			return Entity;
		}

		persistence.jsonToEntityVal = function(value, type) {
			if (type) {
				switch (type) {
					case 'DATE':
						if (typeof value === 'number') {
							if (value > 1000000000000) {
								// it's in milliseconds
								return new Date(value);
							} else {
								return new Date(value * 1000);
							}
						} else {
							return null;
						}
						break;
					default:
						return value;
				}
			} else {
				return value;
			}
		};

		persistence.entityValToJson = function(value, type) {
			if (type) {
				switch (type) {
					case 'DATE':
						if (value) {
							value = new Date(value);
							return Math.round(value.getTime() / 1000);
						} else {
							return null;
						}
						break;
					default:
						return value;
				}
			} else {
				return value;
			}
		};


		/**
		 * Loads a set of entities from a dump object
		 , use `null` to start a new one
		 * @param dump the dump object
		 * @param callback the callback function called when done.
		 */
		persistence.load = function(dump, callback) {

			var loadedEntities = [];
			for (var entityName in dump) {
				if (dump.hasOwnProperty(entityName)) {
					var Entity = this.define(entityName);
					var fields = Entity.meta.fields;
					var instances = dump[entityName];
					for (var i = 0; i < instances.length; i++) {
						if (instances[i] == null)
							continue;
						var incoming = instances[i];
						var ent = (persistence.trackedObjects[entityName] || {})[incoming.id];
						if (ent == null) {// use the cached version
							ent = new Entity();
							ent.id = incoming.id;
							ent._loaded = false; // just an entity ref
						} 
						for (var p in incoming) {
							if (incoming.hasOwnProperty(p) && p !== 'id') {
								ent._loaded = true; // it has data.
								if (persistence.isImmutable(p)) {
									ent[p] = incoming[p];
								} else if (Entity.meta.hasMany[p]) { // collection
									var many = Entity.meta.hasMany[p];
									var coll = persistence.get(ent, p);
									coll._loaded = false;
									if (incoming[p].length > 0) { // this is the actual entities, so init them.
										if (many.manyToMany) {
											// this is going to be a collection of idrefs.
											var idsIn = [];
											angular.forEach(incoming[p], function(ths) {
												idsIn.push(ths.id);
											});
											coll._filter.value = idsIn;
											coll._loaded = false;
										} else {
											var childDump = {};
											childDump[coll._entityName] = incoming[p];
											persistence.load(childDump, function(children) {
												for (var i = 0; i < children.length; i++) {
													persistence.track(children[i]);
												}
											});
										}
									}
								} else if (Entity.meta.hasOne[p]) { // special handling for IDREfs.
									if (typeof incoming[p] === 'string') {
										ent._data[p] = incoming[p];
									} else {
										var childDump = {};
										childDump[Entity.meta.hasOne[p].type.meta.name] = [incoming[p]];
										ent._data[p] = incoming[p].id;
										if (Object.keys(incoming[p]).length > 1) {
											persistence.load(childDump, function(one2one) {
												ent._data_obj[p] = one2one[0];
											});
										}
									}
								} else {
									ent._data[p] = persistence.jsonToEntityVal(incoming[p], fields[p]);
								}
							}
						}
						this.track(ent);
						loadedEntities[loadedEntities.length] = ent;
						ent._dirtyProperties = {};
						ent._new = false;
					}
				}
			}
			if (callback) {
				callback(loadedEntities);
			}
			return loadedEntities;
		};


		/**
		 * Remove all tables in the database (as defined by the model)
		 */
		persistence.reset = function(callback) {

			this.clean();
			callback();
		};

		/**
		 * Dummy
		 */
		persistence.close = function() {
		};


		/**
		 * Generates a UUID according to http://www.ietf.org/rfc/rfc4122.txt
		 */
		function createUUID() {
			if (persistence.typeMapper && persistence.typeMapper.newUuid) {
				return persistence.typeMapper.newUuid();
			}
			var s = [];
			var hexDigits = "0123456789ABCDEF";
			for (var i = 0; i < 32; i++) {
				s[i] = hexDigits.substr(Math.floor(Math.random() * 0x10), 1);
			}
			s[12] = "4";
			s[16] = hexDigits.substr((s[16] & 0x3) | 0x8, 1);

			var uuid = s.join("");
			return uuid;
		}

		persistence.createUUID = createUUID;


		function defaultValue(type) {
			if (persistence.typeMapper && persistence.typeMapper.defaultValue) {
				return persistence.typeMapper.defaultValue(type);
			}
			switch (type) {
				case "TEXT":
					return "";
				case "BOOL":
					return false;
				default:
					if (type.indexOf("INT") !== -1) {
						return 0;
					} else if (type.indexOf("CHAR") !== -1) {
						return "";
					} else {
						return null;
					}
			}
		}

		function arrayContains(ar, item) {
			if (item == null)
				return false;
			for (var i in ar) {
				if (ar.hasOwnProperty(i)) {
					var el = ar[i];
					if (PropertyFilter.prototype.isEqual(el, item))
						return true;
				}
			}
			return false;
		}

		function arrayRemove(ar, item) {
			var l = ar.length;
			for (var i = 0; i < l; i++) {
				var el = ar[i];
				if (el.equals && el.equals(item)) {
					ar.splice(i, 1);
					return;
				} else if (el === item) {
					ar.splice(i, 1);
					return;
				}
			}
		}

		////////////////// QUERY COLLECTIONS \\\\\\\\\\\\\\\\\\\\\\\

		/*
		 * Each filter has 4 methods:
		 * - sql(prefix, values) -- returns a SQL representation of this filter,
		 *     possibly pushing additional query arguments to `values` if ?'s are used
		 *     in the query
		 * - match(o) -- returns whether the filter matches the object o.
		 * - makeFit(o) -- attempts to adapt the object o in such a way that it matches
		 *     this filter.
		 * - makeNotFit(o) -- the oppositive of makeFit, makes the object o NOT match
		 *     this filter
		 */

		/**
		 * Default filter that does not filter on anything
		 * currently it generates a 1=1 SQL query, which is kind of ugly
		 */
		function NullFilter() {
		}

		NullFilter.prototype.match = function(o) {
			return true;
		};

		NullFilter.prototype.makeFit = function(o, quietly) {
		};

		NullFilter.prototype.makeNotFit = function(o) {
		};

		NullFilter.prototype.toUniqueString = function() {
			return "NULL";
		};

		/**
		 * Filter that makes sure that both its left and right filter match
		 * @param left left-hand filter object
		 * @param right right-hand filter object
		 */
		function AndFilter(left, right) {
			this.left = left;
			this.right = right;
		}

		AndFilter.prototype.match = function(o) {
			return this.left.match(o) && this.right.match(o);
		};

		AndFilter.prototype.makeFit = function(o, quietly) {
			this.left.makeFit(o, quietly);
			this.right.makeFit(o, quietly);
		};

		AndFilter.prototype.makeNotFit = function(o) {
			this.left.makeNotFit(o);
			this.right.makeNotFit(o);
		};

		AndFilter.prototype.toUniqueString = function() {
			return this.left.toUniqueString() + " AND " + this.right.toUniqueString();
		};

		/**
		 * Filter that makes sure that either its left and right filter match
		 * @param left left-hand filter object
		 * @param right right-hand filter object
		 */
		function OrFilter(left, right) {
			this.left = left;
			this.right = right;
		}

		OrFilter.prototype.match = function(o) {
			return this.left.match(o) || this.right.match(o);
		};

		OrFilter.prototype.makeFit = function(o, quietly) {
			this.left.makeFit(o);
			this.right.makeFit(o);
		};

		OrFilter.prototype.makeNotFit = function(o) {
			this.left.makeNotFit(o);
			this.right.makeNotFit(o);
		};

		OrFilter.prototype.toUniqueString = function() {
			return this.left.toUniqueString() + " OR " + this.right.toUniqueString();
		};


		/**
		 * Filter that checks whether a certain property matches some value, based on an
		 * operator. Supported operators are '=', '!=', '<', '<=', '>' and '>='.
		 * @param property the property name
		 * @param operator the operator to compare with
		 * @param value the literal value to compare to
		 */
		function PropertyFilter(property, operator, value) {
			this.property = property;
			this.operator = operator.toLowerCase();
			this.value = value;
		}
		
		PropertyFilter.prototype.isEqual = function(propValue, value) {
			if (typeof propValue === 'object' && propValue != null) {
				if (propValue.hasOwnProperty('id')) {
					if (value.hasOwnProperty('id')) {
						return propValue.id === value.id;
					} else {
						return propValue.id === value;
					}
				}
				return propValue.equals(value);
			} else if (typeof value === 'object' && value != null) {
					if (value.hasOwnProperty('id')) {
						if (propValue && propValue.hasOwnProperty('id')) {
							return propValue.id === value.id;
						} else {
							return value.id === propValue;
						}
					}
					return propValue.equals(value);
			} else {
				return value == propValue;
			}
		}

		PropertyFilter.prototype.match = function(o) {
			var value = this.value;
			var propValue;
			try {
				propValue = persistence.get(o, this.property);
			} catch (err) {
				return false;
			}

			if (value && value.getTime) { // DATE
				// TODO: Deal with arrays of dates for 'in' and 'not in'
				value = Math.round(value.getTime() / 1000) * 1000; // Deal with precision
				if (propValue && propValue.getTime) { // DATE
					propValue = Math.round(propValue.getTime() / 1000) * 1000; // Deal with precision
				} else {
					propValue *= 1000;
				}
			}
			switch (this.operator) {
				case '=':
					return PropertyFilter.prototype.isEqual(propValue,value);
					break;
				case '!=':
				case 'ne':
					return propValue !== value;
					break;
				case '<':
				case 'lt':
					return propValue < value;
					break;
				case '<=':
				case 'lte':
					return propValue <= value;
					break;
				case '>':
				case 'gt':
					return propValue > value;
					break;
				case '>=':
				case 'gte':
					return propValue >= value;
					break;
				case 'in':
					return arrayContains(value, propValue);
					break;
				case 'not_in':
					return !arrayContains(value, propValue);
					break;
				case 'contains':
					return propValue.contains(value);
					break;
				case 'like':
					var re = new RegExp('^' + value.replace(/\%/g, '.*'), 'i');
					return re.test(propValue);
			}
		};

		// not entirely sure what this is doing, but my search hack breaks on default implementation
		PropertyFilter.prototype.makeFit = function(o, quietly) {
			if (this.operator === '=') {
				// if it is loaded or new, it is probably dirty
				if ((o._loaded || o._new) && !quietly) {
					persistence.set(o, this.property, this.value, quietly);
				} else { // otherwise it might just be an id_ref
					if (this.value.id) {
						o._data[this.property] = this.value.id;
						o._data_obj[this.property] = this.value;
					}
					else
						o._data = this.value;
				}
			}
		};

		// special case for IN
		PropertyFilter.prototype.toUniqueString = function() {
			var val = this.value;
			if (val && val._type) {
				val = val.id;
			}

			if (this.operator.toLowerCase() === 'in' || this.operator.toLowerCase() == 'not_in') {
				var valArr = '';
				for (var i in val) {
					if (val[i]._type) {
						valArr += val[i].id + ',';
					} else {
						valArr += val[i] + ',';
					}
				}
				val = '{' + valArr + '}';
			}

			var op = this.operator;
			switch (this.operator) {
				case '!=':
					op = 'ne';
					break;
				case '<=':
					op = 'lte';
					break;
				case '<':
					op = 'lt';
					break;
				case '>':
					op = 'gt';
					break;
				case '>=':
					op = 'gte';
					break;
				case 'not in':
					op = 'not_in';
					break;
			}
			return '"' + this.property + '"' + ' ' + op + ' "' + val.toString() + '"';
		};

		PropertyFilter.prototype.makeNotFit = function(o) {
			if (this.operator === '=') {
				// mark the ManyToOne property dirty
				//o._data_obj[this.property].markDirty(this.property);
				persistence.set(o, this.property, null);
			} else {
				throw new Error("Sorry, can't perform makeNotFit for other filters than =");
			}
		};


		persistence.NullFilter = NullFilter;
		persistence.AndFilter = AndFilter;
		persistence.OrFilter = OrFilter;
		persistence.PropertyFilter = PropertyFilter;


		/**
		 * The constructor function of the _abstract_ QueryCollection
		 * DO NOT INSTANTIATE THIS
		 * @constructor
		 */
		function QueryCollection() {
		}

		/**
		 * Function called when session is flushed, returns list of SQL queries to execute
		 * (as [query, arg] tuples)
		 */
		QueryCollection.prototype.persistQueries = function() {
			return [];
		};

		/**
		 * Invoked by sub-classes to initialize the query collection
		 */
		QueryCollection.prototype.init = function(entityName, constructor) {
			this._filter = null;
			this._orderColumns = []; // tuples of [column, ascending]
			this._prefetchFields = [];
			this._entityName = entityName;
			this._constructor = constructor;
			this._limit = -1;
			this._skip = 0;
			this._reverse = false;
			this._only = null
		}

		QueryCollection.prototype.toUniqueString = function() {
			var s = this._constructor.name + ": " + this._entityName;
			s += '|Filter:';
			var values = [];
			s += this._filter ? this._filter.toUniqueString() : '';
			s += '|Values:';
			for (var i = 0; i < values.length; i++) {
				s += values + "|^|";
			}
			s += '|Order:';
			for (var i = 0; i < this._orderColumns.length; i++) {
				var col = this._orderColumns[i];
				s += col[0] + ", " + col[1] + ", " + col[2];
			}
			s += '|Prefetch:';
			for (var i = 0; i < this._prefetchFields.length; i++) {
				s += this._prefetchFields[i];
			}
			s += '|Limit:';
			s += this._limit;
			s += '|Skip:';
			s += this._skip;
			s += '|Reverse:';
			s += this._reverse;
			s += '|Only:';
			s += this._only;
			return s;
		};

		/**
		 * Creates a clone of this query collection
		 * @return a clone of the collection
		 */
		QueryCollection.prototype.clone = function() {
			var c = new (this._constructor)(this._entityName);
			c._filter = this._filter;
			c._prefetchFields = this._prefetchFields.slice(0); // clone
			c._orderColumns = this._orderColumns.slice(0);
			c._limit = this._limit;
			c._skip = this._skip;
			c._reverse = this._reverse;
			c._transient = this._transient;
			c._only = this._only;
			return c;
		};


		/**
		 * Returns a new query collection with a index filter added
		 * @param property the property to filter on
		 * @param value the literal value that the property should match
		 * @return the query collection with the filter added
		 */
		QueryCollection.prototype.only = function(property, value) {
			var c = this.clone(true);
			c._only = [property, value];
			return c;
		};

		/**
		 * Returns a new query collection with a property filter condition added
		 * @param property the property to filter on
		 * @param operator the operator to use
		 * @param value the literal value that the property should match
		 * @return the query collection with the filter added
		 */
		QueryCollection.prototype.filter = function(property, operator, value) {
			var c = this.clone(true);
			if (c._filter != null) {
				c._filter = new AndFilter(this._filter, new PropertyFilter(property, operator, value));
			} else {
				c._filter = new PropertyFilter(property, operator, value);
			}
			return c;
		};



		/**
		 * Returns a new query collection with an OR condition between the
		 * current filter and the filter specified as argument
		 * @param filter the other filter
		 * @return the new query collection
		 */
		QueryCollection.prototype.or = function(filter) {
			var c = this.clone(true);
			c._filter = new OrFilter(this._filter, filter);
			return c;
		};


		/**
		 * Returns a new query collection with an AND condition between the
		 * current filter and the filter specified as argument
		 * @param filter the other filter
		 * @return the new query collection
		 */
		QueryCollection.prototype.and = function(filter) {
			var c = this.clone(true);
			c._filter = new AndFilter(this._filter, filter);
			return c;
		};


		/**
		 * Returns a new query collection with an ordering imposed on the collection
		 * @param property the property to sort on
		 * @param ascending should the order be ascending (= true) or descending (= false)
		 * @param caseSensitive should the order be case sensitive (= true) or case insensitive (= false)
		 *        note: using case insensitive ordering for anything other than TEXT fields yields
		 *        undefinded behavior
		 * @return the query collection with imposed ordering
		 */
		QueryCollection.prototype.order = function(property, ascending, caseSensitive) {
			ascending = ascending === undefined ? true : ascending;
			caseSensitive = caseSensitive === undefined ? true : caseSensitive;
			var c = this.clone();
			c._orderColumns.push([property, ascending, caseSensitive]);
			return c;
		};

		/**
		 * Returns a new query collection will limit its size to n items
		 * @param n the number of items to limit it to
		 * @return the limited query collection
		 */
		QueryCollection.prototype.limit = function(n) {
			var c = this.clone();
			c._limit = n;
			return c;
		};

		/**
		 * Returns a new query collection which will skip the first n results
		 * @param n the number of results to skip
		 * @return the query collection that will skip n items
		 */
		QueryCollection.prototype.skip = function(n) {
			var c = this.clone();
			c._skip = n;
			return c;
		};

		/**
		 * Returns a new query collection which reverse the order of the result set
		 * @return the query collection that will reverse its items
		 */
		QueryCollection.prototype.reverse = function() {
			var c = this.clone();
			c._reverse = true;
			return c;
		};

		/**
		 * Returns a new query collection which will prefetch a certain object relationship.
		 * Only works with 1:1 and N:1 relations.
		 * Relation must target an entity, not a mix-in.
		 * @param rel the relation name of the relation to prefetch
		 * @return the query collection prefetching `rel`
		 */
		QueryCollection.prototype.prefetch = function(rel) {
			var c = this.clone();
			c._prefetchFields.push(rel);
			return c;
		};

		/**
		 * Execute a function for each item in the list
		 * @param eachFn (elem) the function to be executed for each item
		 */
		QueryCollection.prototype.each = function(eachFn) {
			this.list(function(results) {
				for (var i = 0; i < results.length; i++) {
					eachFn(results[i]);
				}
			});
		}

		// Alias
		QueryCollection.prototype.forEach = QueryCollection.prototype.each;

		QueryCollection.prototype.one = function(oneFn) {
			var that = this;

			return this.limit(1).list().then(function(results) {
				if (results.length === 0) {
					oneFn(null);
					return null;
				} else {
					oneFn(results[0]);
					return results[0];
				}
			});
		};

		QueryCollection.prototype.toJSON = function() {
			var jsonChildren = [];
			this.local().list(function(children) {
				angular.forEach(children, function(child) {
					jsonChildren.push({id: child.id});
				});
			});
			return jsonChildren;

		};

		/**
		 * A database implementation of the QueryCollection
		 * @param entityName the name of the entity to create the collection for
		 * @constructor
		 */
		function DbQueryCollection(entityName) {
			this.init(entityName, DbQueryCollection);
		}

		DbQueryCollection.prototype = new QueryCollection();


		/**
		 * Asynchronous call to count the number of items in the collection.
		 * @param callback function to be called when clearing has completed
		 */
		DbQueryCollection.prototype.count = function(callback) {
			var coll = makeLocalClone(this);
			if (persistence.debug)
				console.log('restfully counting: ' + this);
			coll.count(callback);
		};

		/* No matter what, only source objects from the local cache */
		// superceded, all queries are local if db is in-sync
		DbQueryCollection.prototype.local = function() {
			return this;
		};

		/* deprecated - use transient instead*/
		DbQueryCollection.prototype.refresh = function() {
			this._transient = true;
			var c = this.clone();
			return c;
		};

		DbQueryCollection.prototype.transient = function() {
			this._transient = true;
			var c = this.clone();
			return c;
		};


		/**
		 * Asynchronous call to actually fetch the items in the collection

		 * @param callback function to be called taking an array with
		 *   result objects as argument
		 */
		DbQueryCollection.prototype.list = function(callback) {
			if (!this._transient) {
				return this.listCache(callback);
			}

			var qc = this;

			if (persistence.debug)
				console.log('restfully listing: ' + this.toUniqueString());
			var Entity = persistence.define(this._entityName);
			var origin = Entity.meta.origin || 'secure';
//			restfulGet(persistence.endpoint + persistence.dbname + '/' + origin + '/query/', this._entityName,
			var queryUrl = persistence.baseUrl+'/scoring/secure/query/'+this._entityName;

			return $http.post(queryUrl, {
				'filter': this._filter ? this._filter.toUniqueString() : '',
				'join': (this._join || ''),
				'order': this._orderColumns.length > 0 ? this._orderColumns[0] : [], // TODO multiple sort
				'limit': this._limit,
				'skip': this._skip,
				'reverse': this._reverse,
				'prefetch': this._prefetchFields
			}).then(function(response) {
				return persistence.load(response.data, function(items) {
					var thisList = [];
					// index the prefetched entities
					if (qc._prefetchFields.length > 0) {
						angular.forEach(items, function(item) {
							persistence.track(item);
							// if prefetch is enabled, there will be stray entities in here.
						});

					}

					// add them to this collection
					angular.forEach(items, function(item) {
						// if prefetch is enabled, there will be stray entities in here. Ignore them
						if (item._type !== qc._entityName) {
							if (persistence.debug)
								console.log('Got entity of type: ' + item._type);
						} else {
							//qc.add(this);
							thisList.push(item);
						}
					});
					qc._loaded = true;
					if (callback) callback(thisList);
				});
			}).catch(function(err) {
				if (callback) callback(null);
			});
		};



		/**
		 * An implementation of QueryCollection, that is used
		 * to represent all instances of an entity type
		 * @constructor
		 * @param {string} entityName description
		 */
		function AllDbQueryCollection(entityName) {
			this.init(entityName, AllDbQueryCollection);
		}

		AllDbQueryCollection.prototype = new DbQueryCollection();

		AllDbQueryCollection.prototype.add = function(obj) {
			persistence.add(obj);
		};

		AllDbQueryCollection.prototype.remove = function(obj) {
			persistence.remove(obj);
		};


		/**
		 * A ManyToMany implementation of QueryCollection
		 * @constructor
		 * @param {string} entityName description
		 */
		function ManyToManyDbQueryCollection(entityName) {
			this.init(entityName, persistence.ManyToManyDbQueryCollection);
			this._localAdded = [];
			this._localRemoved = [];
		}

		ManyToManyDbQueryCollection.prototype = new DbQueryCollection();



		ManyToManyDbQueryCollection.prototype.initManyToMany = function(obj, coll) {
			this._obj = obj;
			this._coll = coll; // column name
			this._filter = new persistence.PropertyFilter('id', 'IN', []);
		};

		ManyToManyDbQueryCollection.prototype.toJSON = function() {
			var json = [];
			for (var x in this._filter.value) {
				json.push({id: this._filter.value[x]});
			}
			return json;
		};


		ManyToManyDbQueryCollection.prototype.contains = function(value) {
			// is value Entity
			// is it the same type as Collection
			// it's ID is in the value of (IN) filter
			return arrayContains(this._filter.value, value.id);
		};

		ManyToManyDbQueryCollection.prototype.toUniqueString = function() {
			var s = persistence.QueryCollection.prototype.toUniqueString.call(this);
			s += '|Relation:' + this._obj._type + '_' + this._coll;
			s += '|OwnedBy:' + this._obj.id;
			return s;
		};

		ManyToManyDbQueryCollection.prototype.add = function(item, recursing) {
			if (this._filter.hasOwnProperty('value')) {
				if (!arrayContains(this._filter.value, item.id)) {
					this._localAdded.push(item);
					this._filter.value.push(item.id);
				}
			} else {
				// must be and/or
				if (!arrayContains(this._filter.left.value, item.id)) {
					this._localAdded.push(item);
					this._filter.left.value.push(item.id);
				}

			}

			if (!recursing) { // prevent recursively adding to one another
				// Let's find the inverse collection
				var meta = persistence.getMeta(this._obj._type);
				var inverseProperty = meta.hasMany[this._coll].inverseProperty;
				persistence.get(item, inverseProperty).add(this._obj, true);
			}
		};



		ManyToManyDbQueryCollection.prototype.addAll = function(objs) {
			for (var i = 0; i < objs.length; i++) {
				var obj = objs[i];
				if (!arrayContains(this._localAdded, obj)) {
					persistence.add(obj);
					this._localAdded.push(obj);
				}
			}
		};

		ManyToManyDbQueryCollection.prototype.clone = function() {
			var c = DbQueryCollection.prototype.clone.call(this);
			c._localAdded = this._localAdded;
			c._localRemoved = this._localRemoved;
			c._obj = this._obj;
			c._coll = this._coll;
			return c;
		};

		ManyToManyDbQueryCollection.prototype.remove = function(obj) {
			if (arrayContains(this._localAdded, obj)) { // added locally, can just remove it from there
				arrayRemove(this._localAdded, obj);
			} else if (!arrayContains(this._localRemoved, obj)) {
				this._localRemoved.push(obj);
			}
		};

		////////// Local implementation of QueryCollection \\\\\\\\\\\\\\\\

		DbQueryCollection.prototype.listCache = function(callback) {
			if (!callback || callback.executeSql) { // first argument is transaction
				callback = arguments[1]; // set to second argument
			}
			
			/*			coll._entityName = otherColl._entityName;
			coll._filter = otherColl._filter;
			coll._prefetchFields = otherColl._prefetchFields;
			coll._orderColumns = otherColl._orderColumns;
			coll._limit = otherColl._limit;
			coll._skip = otherColl._skip;
			coll._reverse = otherColl._reverse;
			coll._items = persistence.trackedObjects[coll._entityName];
			*/
			
			var meta = persistence.getEntityMeta()[this._entityName];
			var conn;
			if (meta.cacheMode !== 'shared') {
				conn = persistence.syncMeta.connection[this._entityName];
			} else {
				conn = persistence.syncMeta.sharedConnection[this._entityName];
			}
			var qIndex = undefined, desc = false;
			if (this._orderColumns.length > 0) {
				qIndex = this._orderColumns[0][0];
				desc = this._orderColumns[0][1] === false;
			}
			var matcher = this._filter ? this._filter.match : undefined;
			var qc = this;
			
			var all = false;
			var query;
			if (this._only !== null) {
				qIndex = this._only[0];
				//console.log("IDB query on "+this._entityName+"."+this._only[0]+' @ ' + new Date().getTime());
				query = conn.query(this._only[0]).only(this._only[1]);
			} else if (this._filter instanceof PropertyFilter && (this._filter.property === 'id' || meta.indexes[this._filter.property]) && this._filter.operator === '=') {
				//console.log("IDB query on "+this._entityName+"."+this._filter.property+' @ ' + new Date().getTime());
				qIndex = this._filter.property;
				query = conn.query(this._filter.property);
				if (this._filter.value && this._filter.value.constructor.name === 'Entity') {
					query = query.only(this._filter.value.id);
				} else {
					query = query.only(this._filter.value);
				}
			} else {
				//console.log("IDB query on "+this._entityName+"."+qIndex+' @ ' + new Date().getTime());
				query = conn.query(qIndex);
				all = true;
			}
			
			if (matcher){
				query = query.filter(function(record) {
					return matcher.apply(qc._filter, [record]);
				});
				all = false;
			} else {
				if (all) {
					query = query.all();
				}
			}
			if (desc === true) {
				query = query.desc();
			}
			
			if (this._skip) {
				query = query.limit(this._skip, this._limit);
			} else if (this._limit > -1) {
				query = query.limit(this._limit);
			}
			
			return query.execute().then(function(entities) {
				var raw = {};
				raw[qc._entityName] = entities;
				// if the sort order is not the index, re-sort results
				if (qc._orderColumns.length > 0 && qIndex !== qc._orderColumns[0][0]) {
					entities.sort(function(a, b) {
						for (var i = 0; i < qc._orderColumns.length; i++) {
							var col = qc._orderColumns[i][0];
							var asc = qc._orderColumns[i][1];
							var sens = qc._orderColumns[i][2];
							var aVal = persistence.get(a, col);
							var bVal = persistence.get(b, col);
							if (!sens) {
								aVal = aVal.toLowerCase();
								bVal = bVal.toLowerCase();
							}
							if (aVal < bVal) {
								return asc ? -1 : 1;
							} else if (aVal > bVal) {
								return asc ? 1 : -1;
							}
						}
						return 0;
					});
				}
				var loadedEntities = persistence.load(raw)
					// for every entity, I need to find ManyToOnes that are unreferenced and load then into trackedObjects
					
				var wiringUp = [];
				angular.forEach(loadedEntities, function(ent){
					angular.forEach(meta.hasOne, function(toOne, rel) {
						if (ent[rel] && ent[rel].constructor.name !== 'Promise' && !ent[rel]._loaded) {
							console.log(qc._entityName+" with uncached M-1: "+rel);
							ent[rel] = toOne.type.load(ent[rel].id).then(function(relatedEntity){
								ent[rel] = relatedEntity;
								return relatedEntity;
							});
							wiringUp.push(ent[rel]);
						} else if (ent[rel] && ent[rel].constructor.name === 'Promise') {
//							console.log(qc._entityName+" uncached(but fetching): "+rel);
							ent[rel].then(function(val) {
								ent[rel] = val;
								return val;
							});
							wiringUp.push(ent[rel]);
						}
					});
				});
				return $q.all(wiringUp).then(function(){
					if (callback) callback(loadedEntities);
					return loadedEntities;
				});
			});
		};



		persistence.QueryCollection = QueryCollection;
		persistence.DbQueryCollection = DbQueryCollection;
		persistence.ManyToManyDbQueryCollection = ManyToManyDbQueryCollection;
		persistence.AndFilter = AndFilter;
		persistence.OrFilter = OrFilter;
		persistence.PropertyFilter = PropertyFilter;
	}());

	return persistence;
}); // end of createPersistence
